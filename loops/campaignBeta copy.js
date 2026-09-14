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

function hasDatePassedInTimezone(timezone, date) {
  const tz = timezone || "UTC"; // fallback to UTC if not set
  const momentDate = moment.tz(date, tz);
  const currentMoment = moment.tz(tz);
  return momentDate.isBefore(currentMoment);
}

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
      [],
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
          [campaign.campaign_id],
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
    // Fetch PENDING/IN_PROGRESS campaigns — remove schedule filter from SQL
    // We'll do timezone-aware filtering in JS (just like the broadcast code)
    const campaigns = await query(
      `SELECT * FROM beta_campaign 
       WHERE (status = 'PENDING' OR status = 'IN_PROGRESS')
       ORDER BY createdAt ASC
       LIMIT 10`,
      [],
    );

    if (!campaigns || campaigns.length === 0) {
      return;
    }

    for (const campaign of campaigns) {
      // ── Timezone-aware schedule check ──────────────────────
      // If a schedule exists, verify it has passed in the user's timezone
      if (campaign.schedule) {
        const tz = campaign.timezone || "UTC"; // use campaign's timezone, fallback UTC
        if (!hasDatePassedInTimezone(tz, campaign.schedule)) {
          continue; // Not yet time — skip this campaign
        }
      }
      // If no schedule → run immediately (same as before)

      if (processingCampaigns.has(campaign.campaign_id)) {
        continue;
      }

      processingCampaigns.add(campaign.campaign_id);

      try {
        await processSingleCampaign(campaign);
      } catch (error) {
        console.error(
          `Error processing campaign ${campaign.campaign_id}:`,
          error,
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
 * Send a CAROUSEL template message via Meta API
 */
async function sendCarouselTemplateMessage(
  apiVersion,
  phoneNumberId,
  accessToken,
  templateName,
  language,
  recipientPhone,
  globalBodyVariables = [],
  cards = [],
) {
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const components = [];

  // Global body above the carousel (optional)
  if (globalBodyVariables.length > 0) {
    components.push({
      type: "body",
      parameters: globalBodyVariables.map((v) => ({
        type: "text",
        text: String(v || ""),
      })),
    });
  }

  // Build all cards first, then push them as ONE carousel component
  const builtCards = cards.map((card, index) => {
    const cardComponents = [];

    if (card.imageUrl) {
      cardComponents.push({
        type: "header",
        parameters: [{ type: "image", image: { link: card.imageUrl } }],
      });
    }

    if (card.bodyVariables?.length > 0) {
      cardComponents.push({
        type: "body",
        parameters: card.bodyVariables.map((v) => ({
          type: "text",
          text: String(v || ""),
        })),
      });
    }

    if (card.buttonVariables?.length > 0) {
      card.buttonVariables.forEach((bv, bi) => {
        cardComponents.push({
          type: "button",
          sub_type: "url",
          index: String(bv.index ?? bi),
          parameters: [{ type: "text", text: String(bv.value || bv || "") }],
        });
      });
    }

    return { card_index: index, components: cardComponents };
  });

  // All cards go into ONE single carousel component
  if (builtCards.length > 0) {
    components.push({
      type: "carousel",
      cards: builtCards,
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    to: recipientPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: language },
      components,
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return await response.json();
  } catch (error) {
    console.error("Error sending carousel template:", error);
    throw error;
  }
}

/**
 * Send a CATALOG template message via Meta API
 */
async function sendCatalogTemplateMessage(
  apiVersion,
  phoneNumberId,
  accessToken,
  templateName,
  language,
  recipientPhone,
  bodyVariables = [],
  thumbnailProductRetailerId = null, // SKU / Content ID from Commerce Manager
) {
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const components = [];

  // Body variables
  if (bodyVariables.length > 0) {
    components.push({
      type: "body",
      parameters: bodyVariables.map((v) => ({
        type: "text",
        text: String(v || ""),
      })),
    });
  }

  // ✅ Catalog button — thumbnail goes HERE as product retailer ID, not a header
  components.push({
    type: "button",
    sub_type: "CATALOG",
    index: 0,
    parameters: [
      {
        type: "action",
        action: thumbnailProductRetailerId
          ? { thumbnail_product_retailer_id: thumbnailProductRetailerId }
          : {}, // empty = Meta uses first catalog product image automatically
      },
    ],
  });

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipientPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: language },
      components,
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return await response.json();
  } catch (error) {
    console.error("Error sending catalog template:", error);
    throw error;
  }
}

/**
 * Process a single campaign
 */
async function processSingleCampaign(campaign) {
  // Update status to IN_PROGRESS if PENDING
  if (campaign.status === "PENDING") {
    await query(
      "UPDATE beta_campaign SET status = 'IN_PROGRESS' WHERE campaign_id = ?",
      [campaign.campaign_id],
    );
  }

  // Get pending logs for this campaign
  const pendingLogs = await query(
    `SELECT * FROM beta_campaign_logs 
     WHERE campaign_id = ? 
     AND status = 'PENDING'
     ORDER BY id ASC
     LIMIT ?`,
    [campaign.campaign_id, CONFIG.batchSize],
  );

  if (!pendingLogs || pendingLogs.length === 0) {
    await checkAndMarkCampaignComplete(campaign);
    return;
  }

  // Get meta API credentials
  const metaCredentials = await query(
    "SELECT * FROM meta_api WHERE uid = ? LIMIT 1",
    [campaign.uid],
  );

  if (!metaCredentials || metaCredentials.length === 0) {
    await query(
      `UPDATE beta_campaign_logs 
       SET status = 'FAILED', error_message = 'Meta API credentials not found'
       WHERE campaign_id = ? AND status = 'PENDING'`,
      [campaign.campaign_id],
    );
    await updateCampaignCounts(campaign.campaign_id);
    await checkAndMarkCampaignComplete(campaign);
    return;
  }

  // ── Parse campaign variables ──────────────────────────────
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

  // ── Detect template type from packed headerVariable ───────
  // STANDARD : headerVariable = { type:"STANDARD", url, filename, mediaType }
  //            OR null (no header)
  //            OR legacy string (old campaigns before this update)
  // CAROUSEL : headerVariable = { type:"CAROUSEL", cards:[...] }
  // CATALOG  : headerVariable = { type:"CATALOG",  thumbnail: url|null }
  const templateType =
    headerVariable?.type === "CAROUSEL"
      ? "CAROUSEL"
      : headerVariable?.type === "CATALOG"
        ? "CATALOG"
        : "STANDARD";

  const credentials = metaCredentials[0];
  const successfulIds = [];
  const failedUpdates = [];

  for (const log of pendingLogs) {
    try {
      // Get contact details for variable replacement
      const contact = await getContactForLog(log, campaign);

      let result;

      // ── CAROUSEL send ─────────────────────────────────────
      if (templateType === "CAROUSEL") {
        const cards = (headerVariable.cards || []).map((card) => ({
          imageUrl: card.imageUrl,
          bodyVariables: replaceContactVariables(
            card.bodyVariables || [],
            contact,
          ),
          buttonVariables: replaceContactVariables(
            card.buttonVariables || [],
            contact,
          ),
        }));

        result = await sendCarouselTemplateMessage(
          "v18.0",
          credentials.business_phone_number_id,
          credentials.access_token,
          campaign.template_name,
          campaign.template_language,
          log.contact_mobile,
          replaceContactVariables(bodyVariables, contact), // global body above cards
          cards,
        );

        // ── CATALOG send ──────────────────────────────────────
      } else if (templateType === "CATALOG") {
        const processedBodyVars = replaceContactVariables(
          bodyVariables,
          contact,
        );

        result = await sendCatalogTemplateMessage(
          "v18.0",
          credentials.business_phone_number_id,
          credentials.access_token,
          campaign.template_name,
          campaign.template_language,
          log.contact_mobile,
          processedBodyVars,
          headerVariable.thumbnail || null,
        );

        // ── STANDARD send (your original logic, unchanged) ────
      } else {
        // STANDARD — headerVariable.type is now correctly "image"/"video"/"document"
        const processedBodyVars = replaceContactVariables(
          bodyVariables,
          contact,
        );
        const processedHeaderVar = replaceContactVariable(
          headerVariable,
          contact,
        );
        const processedButtonVars = replaceContactVariables(
          buttonVariables,
          contact,
        );

        result = await sendTemplateMessage(
          "v18.0",
          credentials.business_phone_number_id,
          credentials.access_token,
          campaign.template_name,
          campaign.template_language,
          log.contact_mobile,
          processedBodyVars,
          processedHeaderVar, // ← now { type:"image", url:"...", filename:"..." } ✅
          processedButtonVars,
        );
      }

      // ── Handle result (same for all types) ───────────────
      if (result && result.messages && result.messages.length > 0) {
        successfulIds.push({ id: log.id, messageId: result.messages[0].id });
      } else {
        const errorMsg = result?.error?.message || "No message ID returned";
        failedUpdates.push({ id: log.id, error: errorMsg });
      }

      await new Promise((resolve) => setTimeout(resolve, CONFIG.messageDelay));
    } catch (error) {
      console.error(`Error sending to ${log.contact_mobile}:`, error.message);
      failedUpdates.push({ id: log.id, error: error.message });
    }
  }

  // Batch update successful sends (unchanged)
  if (successfulIds.length > 0) {
    for (const success of successfulIds) {
      await query(
        `UPDATE beta_campaign_logs 
         SET status = 'SENT', meta_msg_id = ?, delivery_time = NOW()
         WHERE id = ?`,
        [success.messageId, success.id],
      );
    }
  }

  // Batch update failed sends (unchanged)
  if (failedUpdates.length > 0) {
    for (const failed of failedUpdates) {
      await query(
        `UPDATE beta_campaign_logs 
         SET status = 'FAILED', error_message = ?
         WHERE id = ?`,
        [failed.error, failed.id],
      );
    }
  }

  await updateCampaignCounts(campaign.campaign_id);
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
    [log.contact_mobile, campaign.uid, campaign.phonebook_id],
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
      [campaignId, campaignId, campaignId, campaignId, campaignId],
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
    [campaign.campaign_id],
  );

  const [totalLogsCount] = await query(
    `SELECT COUNT(*) as count FROM beta_campaign_logs 
     WHERE campaign_id = ?`,
    [campaign.campaign_id],
  );

  // If no pending logs and we have some logs, mark as complete
  if (pendingCount.count === 0 && totalLogsCount.count > 0) {
    await query(
      "UPDATE beta_campaign SET status = 'COMPLETED' WHERE campaign_id = ?",
      [campaign.campaign_id],
    );
    // console.log(`✅ Campaign ${campaign.campaign_id} marked as COMPLETED`);
  }
  // If no logs at all, mark as completed (legacy case)
  else if (totalLogsCount.count === 0) {
    await query(
      "UPDATE beta_campaign SET status = 'COMPLETED' WHERE campaign_id = ?",
      [campaign.campaign_id],
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
      [metaMsgId],
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
      [status, errorMessage, metaMsgId],
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
  sendCarouselTemplateMessage,
  sendCatalogTemplateMessage,
};
