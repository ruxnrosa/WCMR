const { query } = require("../database/dbpromise");
const { sendTemplateMessage } = require("../functions/function");

// Simple processing flags
const processingCampaigns = new Set();

// Configuration
const CONFIG = {
  batchSize: 20, // Messages per batch
  checkInterval: 30000, // Check every 3 seconds
  messageDelay: 300, // 300ms between messages
  maxRetries: 3,
  retryDelay: 5000,
};

/**
 * Initialize the campaign processing system
 */
async function initCampaign() {
  // console.log("Campaign processing system initialized");

  // Handle legacy campaigns on startup
  await handleLegacyCampaigns();

  const interval = setInterval(async () => {
    try {
      await processPendingCampaigns();
    } catch (error) {
      console.error("Error in campaign processing loop:", error);
    }
  }, CONFIG.checkInterval);

  // Initial run after 1 second
  setTimeout(() => processPendingCampaigns(), 1000);

  return interval;
}

/**
 * Handle legacy campaigns - mark them as COMPLETED if no logs
 */
async function handleLegacyCampaigns() {
  try {
    // console.log("Checking for legacy campaigns...");

    // Find campaigns that are PENDING/IN_PROGRESS but have no logs
    const legacyCampaigns = await query(
      `SELECT c.campaign_id, c.title 
       FROM beta_campaign c
       LEFT JOIN beta_campaign_logs l ON c.campaign_id = l.campaign_id
       WHERE c.status IN ('PENDING', 'IN_PROGRESS')
       AND l.campaign_id IS NULL`,
      []
    );

    if (legacyCampaigns.length > 0) {
      // console.log(
      //   `Found ${legacyCampaigns.length} legacy campaigns without logs`
      // );

      // Mark them as COMPLETED
      for (const campaign of legacyCampaigns) {
        await query(
          `UPDATE beta_campaign 
           SET status = 'COMPLETED' 
           WHERE campaign_id = ?`,
          [campaign.campaign_id]
        );

        // console.log(
        //   `Marked legacy campaign as COMPLETED: ${campaign.campaign_id} - ${campaign.title}`
        // );
      }

      // console.log(
      //   `✅ Marked ${legacyCampaigns.length} legacy campaigns as COMPLETED`
      // );
    } else {
      // console.log("No legacy campaigns found");
    }
  } catch (error) {
    console.error("Error handling legacy campaigns:", error);
  }
}

/**
 * Process pending campaigns
 */
async function processPendingCampaigns() {
  try {
    // Get campaigns that need processing
    const campaigns = await query(
      `SELECT * FROM beta_campaign 
       WHERE (status = 'PENDING' OR status = 'IN_PROGRESS')
       AND (schedule IS NULL OR schedule <= NOW())
       ORDER BY createdAt ASC
       LIMIT 5`,
      []
    );

    if (!campaigns || campaigns.length === 0) {
      return;
    }

    // Process each campaign
    for (const campaign of campaigns) {
      if (processingCampaigns.has(campaign.campaign_id)) {
        continue; // Skip if already processing
      }

      processingCampaigns.add(campaign.campaign_id);

      try {
        await processSingleCampaign(campaign);
      } catch (error) {
        console.error(
          `Error processing campaign ${campaign.campaign_id}:`,
          error
        );
      } finally {
        processingCampaigns.delete(campaign.campaign_id);
      }
    }
  } catch (error) {
    console.error("Error in processPendingCampaigns:", error);
  }
}

/**
 * Process a single campaign
 */
async function processSingleCampaign(campaign) {
  // console.log(`Processing campaign: ${campaign.campaign_id}`);

  // Update status to IN_PROGRESS if PENDING
  if (campaign.status === "PENDING") {
    await query(
      "UPDATE beta_campaign SET status = 'IN_PROGRESS' WHERE campaign_id = ?",
      [campaign.campaign_id]
    );
  }

  // Get pending logs for this campaign
  const pendingLogs = await query(
    `SELECT * FROM beta_campaign_logs 
     WHERE campaign_id = ? 
     AND status = 'PENDING'
     ORDER BY id ASC
     LIMIT ?`,
    [campaign.campaign_id, CONFIG.batchSize]
  );

  if (!pendingLogs || pendingLogs.length === 0) {
    // No pending logs - check if campaign should be completed
    await checkAndMarkCampaignComplete(campaign);
    return;
  }

  // console.log(
  //   `Processing ${pendingLogs.length} messages for campaign ${campaign.campaign_id}`
  // );

  // Get meta API credentials
  const metaCredentials = await query(
    "SELECT * FROM meta_api WHERE uid = ? LIMIT 1",
    [campaign.uid]
  );

  if (!metaCredentials || metaCredentials.length === 0) {
    // Mark all pending logs as failed
    await query(
      `UPDATE beta_campaign_logs 
       SET status = 'FAILED', error_message = 'Meta API credentials not found'
       WHERE campaign_id = ? AND status = 'PENDING'`,
      [campaign.campaign_id]
    );

    // Update campaign failed count
    await updateCampaignCounts(campaign.campaign_id);
    await checkAndMarkCampaignComplete(campaign);
    return;
  }

  // Parse campaign variables
  let bodyVariables = [];
  let headerVariable = null;
  let buttonVariables = [];

  try {
    bodyVariables = campaign.body_variables
      ? JSON.parse(campaign.body_variables)
      : [];
    headerVariable = campaign.header_variable
      ? JSON.parse(campaign.header_variable)
      : null;
    buttonVariables = campaign.button_variables
      ? JSON.parse(campaign.button_variables)
      : [];
  } catch (e) {
    console.error(`Error parsing campaign variables: ${e.message}`);
  }

  // Process each log
  const credentials = metaCredentials[0];
  const successfulIds = [];
  const failedUpdates = [];

  for (const log of pendingLogs) {
    try {
      // Get contact details for variable replacement
      const contact = await getContactForLog(log, campaign);

      // Replace variables
      const processedBodyVars = replaceContactVariables(bodyVariables, contact);
      const processedHeaderVar = replaceContactVariable(
        headerVariable,
        contact
      );
      const processedButtonVars = replaceContactVariables(
        buttonVariables,
        contact
      );

      // console.log(`Sending message to ${log.contact_mobile}...`);

      // Send message
      const result = await sendTemplateMessage(
        "v18.0",
        credentials.business_phone_number_id,
        credentials.access_token,
        campaign.template_name,
        campaign.template_language,
        log.contact_mobile,
        processedBodyVars,
        processedHeaderVar,
        processedButtonVars
      );

      if (result && result.messages && result.messages.length > 0) {
        const messageId = result.messages[0].id;
        successfulIds.push({
          id: log.id,
          messageId: messageId,
        });
        // console.log(
        //   `✓ Sent to ${log.contact_mobile} - Message ID: ${messageId}`
        // );
      } else {
        const errorMsg = result?.error?.message || "No message ID returned";
        failedUpdates.push({
          id: log.id,
          error: errorMsg,
        });
        // console.log(`✗ Failed to send to ${log.contact_mobile}: ${errorMsg}`);
      }

      // Delay between messages
      await new Promise((resolve) => setTimeout(resolve, CONFIG.messageDelay));
    } catch (error) {
      console.error(`Error sending to ${log.contact_mobile}:`, error.message);
      failedUpdates.push({
        id: log.id,
        error: error.message,
      });
    }
  }

  // Batch update successful sends
  if (successfulIds.length > 0) {
    for (const success of successfulIds) {
      await query(
        `UPDATE beta_campaign_logs 
         SET status = 'SENT', meta_msg_id = ?, delivery_time = NOW()
         WHERE id = ?`,
        [success.messageId, success.id]
      );
    }
    // console.log(`✓ Successfully sent ${successfulIds.length} messages`);
  }

  // Batch update failed sends
  if (failedUpdates.length > 0) {
    for (const failed of failedUpdates) {
      await query(
        `UPDATE beta_campaign_logs 
         SET status = 'FAILED', error_message = ?
         WHERE id = ?`,
        [failed.error, failed.id]
      );
    }
    // console.log(`✗ Failed to send ${failedUpdates.length} messages`);
  }

  // Update campaign counts
  await updateCampaignCounts(campaign.campaign_id);

  // Check if campaign is complete
  await checkAndMarkCampaignComplete(campaign);
}

/**
 * Get contact details for a log entry
 */
async function getContactForLog(log, campaign) {
  const contacts = await query(
    `SELECT * FROM contact 
     WHERE mobile = ? AND uid = ? AND phonebook_id = ?
     LIMIT 1`,
    [log.contact_mobile, campaign.uid, campaign.phonebook_id]
  );

  if (contacts && contacts.length > 0) {
    return contacts[0];
  }

  // Fallback to log data
  return {
    name: log.contact_name,
    mobile: log.contact_mobile,
    var1: "",
    var2: "",
    var3: "",
    var4: "",
    var5: "",
  };
}

/**
 * Update campaign counts based on current log statuses
 */
async function updateCampaignCounts(campaignId) {
  try {
    await query(
      `UPDATE beta_campaign SET
        sent_count = (SELECT COUNT(*) FROM beta_campaign_logs WHERE campaign_id = ? AND status = 'SENT'),
        failed_count = (SELECT COUNT(*) FROM beta_campaign_logs WHERE campaign_id = ? AND status = 'FAILED'),
        delivered_count = (SELECT COUNT(*) FROM beta_campaign_logs WHERE campaign_id = ? AND delivery_status = 'delivered'),
        read_count = (SELECT COUNT(*) FROM beta_campaign_logs WHERE campaign_id = ? AND delivery_status = 'read')
       WHERE campaign_id = ?`,
      [campaignId, campaignId, campaignId, campaignId, campaignId]
    );
  } catch (error) {
    console.error(`Error updating campaign counts for ${campaignId}:`, error);
  }
}

/**
 * Check if campaign is complete and mark it
 */
async function checkAndMarkCampaignComplete(campaign) {
  const [pendingCount] = await query(
    `SELECT COUNT(*) as count FROM beta_campaign_logs 
     WHERE campaign_id = ? AND status = 'PENDING'`,
    [campaign.campaign_id]
  );

  const [totalLogsCount] = await query(
    `SELECT COUNT(*) as count FROM beta_campaign_logs 
     WHERE campaign_id = ?`,
    [campaign.campaign_id]
  );

  // If no pending logs and we have some logs, mark as complete
  if (pendingCount.count === 0 && totalLogsCount.count > 0) {
    await query(
      "UPDATE beta_campaign SET status = 'COMPLETED' WHERE campaign_id = ?",
      [campaign.campaign_id]
    );
    // console.log(`✅ Campaign ${campaign.campaign_id} marked as COMPLETED`);
  }
  // If no logs at all, mark as completed (legacy case)
  else if (totalLogsCount.count === 0) {
    await query(
      "UPDATE beta_campaign SET status = 'COMPLETED' WHERE campaign_id = ?",
      [campaign.campaign_id]
    );
    // console.log(
    //   `✅ Campaign ${campaign.campaign_id} marked as COMPLETED (no logs - legacy)`
    // );
  }
}

/**
 * Replace contact variables in an array
 */
function replaceContactVariables(variables, contact) {
  if (!Array.isArray(variables)) return variables;
  return variables.map((variable) => replaceContactVariable(variable, contact));
}

/**
 * Replace contact variable in a single variable
 */
function replaceContactVariable(variable, contact) {
  if (typeof variable !== "string") return variable;

  // Replace {{{name}}} pattern
  let result = variable.replace(/\{\{\{name\}\}\}/g, contact.name || "");

  // Replace {{{mobile}}} pattern
  result = result.replace(/\{\{\{mobile\}\}\}/g, contact.mobile || "");

  // Replace {{{var1}}} to {{{var5}}} patterns
  for (let i = 1; i <= 5; i++) {
    const pattern = new RegExp(`\\{\\{\\{var${i}\\}\\}\\}`, "g");
    result = result.replace(pattern, contact[`var${i}`] || "");
  }

  return result;
}

/**
 * Handle webhook updates for message status
 */
async function updateMessageStatus(metaMsgId, status, errorMessage = null) {
  try {
    // Add small delay to ensure message is in database
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // console.log(`Updating message ${metaMsgId} status to ${status}`);

    // Find the log entry
    const logs = await query(
      "SELECT * FROM beta_campaign_logs WHERE meta_msg_id = ? LIMIT 1",
      [metaMsgId]
    );

    if (!logs || logs.length === 0) {
      // console.log(`No log found for message ID: ${metaMsgId}`);
      return;
    }

    const log = logs[0];

    // Don't downgrade status (read is higher than delivered)
    if (log.delivery_status === "read" && status === "delivered") {
      // console.log(
      //   `Message ${metaMsgId} already marked as read, not downgrading to delivered`
      // );
      return;
    }

    // Update delivery status
    await query(
      `UPDATE beta_campaign_logs 
       SET delivery_status = ?, delivery_time = NOW(), error_message = ?
       WHERE meta_msg_id = ?`,
      [status, errorMessage, metaMsgId]
    );

    // Update campaign counters
    await updateCampaignCounts(log.campaign_id);

    // console.log(`✅ Updated message ${metaMsgId} status to ${status}`);
  } catch (error) {
    console.error(`Error updating message status for ${metaMsgId}:`, error);
  }
}

module.exports = {
  initCampaign,
  updateMessageStatus,
};
