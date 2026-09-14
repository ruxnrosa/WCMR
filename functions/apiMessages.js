// functions/apiMessages.js
const fetch = require("node-fetch");
const randomstring = require("randomstring");
const { query } = require("../database/dbpromise.js");

// Function to update message status
const updateMessageStatus = async (messageId, status, timestamp = null) => {
  try {
    // Update the message status in the database
    await query(
      `UPDATE beta_api_messages SET status = ?, updated_at = ? WHERE meta_msg_id = ?`,
      [status, timestamp || new Date(), messageId]
    );

    // Get the message details to update analytics
    const message = await query(
      `SELECT uid FROM beta_api_messages WHERE meta_msg_id = ?`,
      [messageId]
    );

    if (message && message.length > 0) {
      const uid = message[0].uid;
      const today = new Date().toISOString().split("T")[0];

      // Update analytics
      const statusField = `messages_${status}`;
      await query(
        `INSERT INTO beta_api_analytics (uid, date, ${statusField}) 
         VALUES (?, ?, 1) 
         ON DUPLICATE KEY UPDATE ${statusField} = ${statusField} + 1`,
        [uid, today]
      );
    }

    return true;
  } catch (error) {
    console.error("Error updating message status:", error);
    return false;
  }
};

// Function to send a message via WhatsApp API
const sendAPIMessage = async (messageObject, waNumId, waToken) => {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v17.0/${waNumId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${waToken}`,
        },
        body: JSON.stringify(messageObject),
      }
    );

    const data = await response.json();

    if (data.error) {
      return {
        success: false,
        message: data.error.message,
        metaResponse: data,
      };
    }

    return {
      success: true,
      message: "Message sent successfully!",
      metaResponse: data,
    };
  } catch (error) {
    console.error("Error sending message:", error);
    return {
      success: false,
      message: "Failed to send message",
      error: error.toString(),
    };
  }
};

// Function to send a template message
const sendMetatemplet = async (
  sendTo,
  waNumId,
  waToken,
  template,
  components,
  mediaUri = null
) => {
  try {
    const templateName = template.name;
    const templateLanguage = template.language || "en";

    // Prepare the message object
    const messageObject = {
      to: sendTo,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: templateLanguage,
        },
        components: [],
      },
    };

    // Add components if provided
    if (components && components.length > 0) {
      messageObject.template.components = [
        {
          type: "body",
          parameters: components.map((text) => ({
            type: "text",
            text,
          })),
        },
      ];
    }

    // Add media if provided
    if (mediaUri) {
      messageObject.template.components.unshift({
        type: "header",
        parameters: [
          {
            type: "image",
            image: {
              link: mediaUri,
            },
          },
        ],
      });
    }

    // Send the message
    return await sendAPIMessage(messageObject, waNumId, waToken);
  } catch (error) {
    console.error("Error sending template message:", error);
    return {
      success: false,
      message: "Failed to send template message",
      error: error.toString(),
    };
  }
};

module.exports = {
  updateMessageStatus,
  sendAPIMessage,
  sendMetatemplet,
};
