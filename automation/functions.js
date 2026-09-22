const { query } = require("../database/dbpromise");
const {
  getCurrentTimestampInTimeZone,
  saveMessageToConversation,
  makeRequestBeta,
  sendEmailBeta,
  executeMySQLQuery,
} = require("../functions/function");
const { setQrMsgObj, sendMetaMsg } = require("../helper/socket/function");
const fetch = require("node-fetch");
const { google } = require("googleapis");
const { aiTransferHandler } = require("./useAITransferHandler");
const FormData = require("form-data");
const {} = require("../helper/addon/telegram/processTelegramInbox");

// Add this new function for sending media messages (to avoid rate limits)
async function sendMetaMsgWithMediaUpload({ uid, to, msgObj }) {
  try {
    const [api] = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
    if (!api || !api?.access_token || !api?.business_phone_number_id) {
      return { success: false, msg: "Please add your meta API keys" };
    }

    function formatNumber(number) {
      return number?.replace("+", "");
    }

    const waToken = api?.access_token;
    const waNumId = api?.business_phone_number_id;

    let finalMsgObj = { ...msgObj };

    // ✅ Upload media to Meta first (to avoid rate limits)
    const mediaTypes = ["image", "video", "document", "audio"];
    if (mediaTypes.includes(msgObj.type)) {
      const mediaKey = msgObj.type;
      const mediaUrl = msgObj[mediaKey]?.link;

      if (mediaUrl) {
        console.log(
          `📤 Uploading ${msgObj.type} to Meta to avoid rate limits...`,
        );

        try {
          // Step 1: Download media from your server
          const mediaResponse = await fetch(mediaUrl);
          if (!mediaResponse.ok) {
            throw new Error(
              `Failed to download media: ${mediaResponse.statusText}`,
            );
          }

          const mediaBuffer = await mediaResponse.buffer();
          const contentType =
            mediaResponse.headers.get("content-type") ||
            "application/octet-stream";

          // Step 2: Upload to Meta
          const form = new FormData();

          // Determine filename based on type
          let filename = "media_file";
          if (msgObj.type === "image") filename = "image.jpg";
          else if (msgObj.type === "video") filename = "video.mp4";
          else if (msgObj.type === "audio") filename = "audio.mp3";
          else if (msgObj.type === "document")
            filename = msgObj[mediaKey]?.filename || "document.pdf";

          form.append("file", mediaBuffer, {
            contentType: contentType,
            filename: filename,
          });
          form.append("messaging_product", "whatsapp");

          const uploadResponse = await fetch(
            `https://graph.facebook.com/v17.0/${waNumId}/media`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${waToken}`,
                ...form.getHeaders(),
              },
              body: form,
            },
          );

          const uploadResult = await uploadResponse.json();

          if (uploadResult.id) {
            console.log(`✅ Media uploaded to Meta. ID: ${uploadResult.id}`);

            // Replace link with Meta media ID
            finalMsgObj[mediaKey] = {
              id: uploadResult.id,
            };

            // Keep caption if exists
            if (msgObj[mediaKey]?.caption) {
              finalMsgObj[mediaKey].caption = msgObj[mediaKey].caption;
            }

            // Keep filename for documents
            if (msgObj.type === "document" && msgObj[mediaKey]?.filename) {
              finalMsgObj[mediaKey].filename = msgObj[mediaKey].filename;
            }
          } else {
            console.error("❌ Meta media upload failed:", uploadResult);
            console.log("⚠️ Falling back to direct URL with delay...");
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        } catch (uploadError) {
          console.error("Error uploading media to Meta:", uploadError);
          console.log("⚠️ Falling back to direct URL with delay...");
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    }

    // Special handling for audio
    if (finalMsgObj?.type === "audio" && finalMsgObj?.audio?.link) {
      finalMsgObj = {
        type: finalMsgObj?.type,
        audio: {
          link: finalMsgObj?.audio?.link,
        },
      };
    }

    const url = `https://graph.facebook.com/v17.0/${waNumId}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatNumber(to),
      ...finalMsgObj,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${waToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (data?.error) {
      return { success: false, msg: data?.error?.message };
    }

    if (data?.messages[0]?.id) {
      const metaMsgId = data?.messages[0]?.id;
      return { success: true, id: metaMsgId };
    } else {
      return { success: false, msg: JSON.stringify(data) };
    }
  } catch (err) {
    console.error("Error in sendMetaMsgWithMediaUpload:", err);
    return { success: false, msg: err?.toString() };
  }
}

const replaceJsonWithVarsNew = (data, variables) => {
  // Recursively handle different types of values (string, object, array)
  const processValue = (val, variables) => {
    if (typeof val === "string") {
      // If the value is a string, check if it contains a placeholder
      const regex = /{{{(.*?)}}}/g;
      return val.replace(regex, (match, key) => {
        // Extract the key and try to get the corresponding value from the variables object
        let keys = key.split(".");
        let resolvedValue = variables;
        for (const k of keys) {
          resolvedValue = resolvedValue ? resolvedValue[k] : undefined;
        }
        return resolvedValue !== undefined ? resolvedValue : match; // If not found, keep the original value
      });
    }

    if (Array.isArray(val)) {
      return val.map((item) => processValue(item, variables));
    }

    if (typeof val === "object" && val !== null) {
      const result = {};
      for (const key in val) {
        result[key] = processValue(val[key], variables);
      }
      return result;
    }

    return val; // Return the value if it's not a string, array, or object
  };

  return processValue(data, variables);
};

async function pushNewKeyInData({ key, pushObj, flowSession }) {
  try {
    // Fetch only needed column
    const [oldData] = await query(
      `SELECT data FROM flow_session WHERE id = ? LIMIT 1`,
      [flowSession?.id],
    );

    if (!oldData) {
      console.log("No data found for the provided flowSession ID.");
      return;
    }

    const oldDataObj = JSON.parse(oldData.data || "{}");

    if (!oldDataObj[key]) {
      oldDataObj[key] = {};
    }

    oldDataObj[key] = {
      ...oldDataObj[key],
      ...pushObj,
    };

    await query(
      `UPDATE flow_session 
       SET data = ? 
       WHERE id = ?
       LIMIT 1`,
      [JSON.stringify(oldDataObj), flowSession?.id],
    );
  } catch (err) {
    console.log("Error during updating flow_session data:", err);
  }
}

function replaceVarFromString(inputString, variables) {
  return inputString.replace(
    /{{{(\w+)}}}/g,
    (match, p1) => variables[p1] || match,
  );
}

const replaceJsonWithVar = (val, variables) => {
  if (typeof val === "string") {
    if (val.startsWith("{{{") && val.endsWith("}}}")) {
      const key = val.slice(3, -3).trim();
      const keys = key.split(".");
      let resolvedValue = variables;

      for (const k of keys) {
        resolvedValue = resolvedValue && resolvedValue[k];
      }

      return resolvedValue !== undefined ? resolvedValue : val;
    } else {
      return val;
    }
  }

  if (typeof val === "object" && val !== null) {
    const result = Array.isArray(val) ? [] : {};
    for (const key in val) {
      result[key] = replaceJsonWithVar(val[key], variables);
    }
    return result;
  }

  return val;
};

async function authenticate(credentials) {
  const { client_email, private_key } = credentials;

  const auth = new google.auth.JWT(client_email, null, private_key, [
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

async function getSheetByName(sheets, spreadsheetId, sheetName) {
  try {
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    const sheet = spreadsheet.data.sheets.find(
      (s) => s.properties.title === sheetName,
    );

    if (!sheet) {
      return { exists: false };
    }

    const data = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
    });

    return {
      exists: true,
      data: data.data.values || [],
      sheetId: sheet.properties.sheetId,
      properties: sheet.properties,
    };
  } catch (error) {
    console.error("Error getting sheet:", error.message);
    throw error;
  }
}

async function pushOrCreateSheet(sheets, spreadsheetId, sheetName, data) {
  try {
    // First check if sheet exists
    const sheetInfo = await getSheetByName(sheets, spreadsheetId, sheetName);

    if (!sheetInfo.exists) {
      // Create the sheet if it doesn't exist
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: sheetName,
                  gridProperties: {
                    rowCount: 1000,
                    columnCount: 26,
                  },
                },
              },
            },
          ],
        },
      });
      console.log(`Created new sheet: ${sheetName}`);
    }

    // Prepare data (convert object to array if needed)
    const values = Array.isArray(data) ? data : [Object.values(data)];

    // Push data to sheet
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      resource: { values },
    });

    return {
      success: true,
      updatedCells: result.data.updates.updatedCells,
      updatedRange: result.data.updates.updatedRange,
    };
  } catch (error) {
    console.error("Error in pushOrCreateSheet:", error.message);
    throw error;
  }
}

async function pushSpreadSheet({ authUrl, sheetName, sheetId, jsonData }) {
  try {
    const res = await fetch(authUrl);
    if (!res.ok) throw new Error("Failed to fetch service account JSON");
    const credsPath = await res.json();

    const spreadsheetId = sheetId;

    const sheets = await authenticate(credsPath);
    const sheetData = await getSheetByName(sheets, spreadsheetId, sheetName);
    console.log("Sheet exists:", sheetData.exists);

    const pushResult = await pushOrCreateSheet(
      sheets,
      spreadsheetId,
      sheetName,
      jsonData,
    );

    console.log("Push result:", pushResult);
  } catch (err) {
    console.log(err);
  }
}

function delay(sec) {
  return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}

function mapVariablesToResponse(variables, response) {
  function getNestedValueFromPath(obj, path) {
    try {
      const parts = path.split(/[\.\[\]]/).filter(Boolean);
      return parts.reduce((acc, part) => {
        if (acc === undefined || acc === null) return undefined;
        return isNaN(part) ? acc[part] : acc[parseInt(part)];
      }, obj);
    } catch {
      return undefined;
    }
  }

  const result = {};

  variables.forEach(({ key, value }) => {
    if (!value || !value.includes("body")) return;

    try {
      if (value.startsWith("body.")) {
        const path = value.slice(5);
        const val = getNestedValueFromPath(response.body, path);
        if (val !== undefined) result[key] = val;
      } else {
        // Expression like JSON.stringify(body.items[0])
        const func = new Function("body", `return ${value}`);
        result[key] = func(response.body);
      }
    } catch (e) {
      // Optional: log errors if needed
    }
  });

  return result;
}

// function mapVariablesToResponse(variables, response) {
//   function getNestedValue(obj, path) {
//     return path.split(".").reduce((acc, part) => acc && acc[part], obj);
//   }

//   const result = {};

//   // Loop through each variable in the variables array
//   variables.forEach((variable) => {
//     const { key, value } = variable;

//     // Safely access the property in response.body using value (e.g., body.name)
//     if (value && value.startsWith("body.")) {
//       const path = value.slice(5); // Removing 'body.' prefix

//       // Use a helper function to safely access nested values
//       const resultValue = getNestedValue(response.body, path);

//       if (resultValue !== undefined) {
//         result[key] = resultValue;
//       }
//     }
//   });

//   return result;
// }

function addDurationToTimestamp(hours, minutes) {
  // Get the current timestamp
  let currentTime = new Date();

  // Add hours and minutes to the current time
  currentTime.setHours(currentTime.getHours() + hours);
  currentTime.setMinutes(currentTime.getMinutes() + minutes);

  // Return the timestamp
  return currentTime.getTime();
}

function setVariables(variables, obj) {
  const result = {};

  variables.forEach((variable) => {
    const pathParts = variable.responsePath.split(".");

    let value = obj;

    for (let part of pathParts) {
      const match = part.match(/^(\w+)\[(\d+)\]$/);
      if (match) {
        // e.g., response[0]
        const key = match[1];
        const index = parseInt(match[2], 10);
        if (
          value[key] &&
          Array.isArray(value[key]) &&
          value[key][index] !== undefined
        ) {
          value = value[key][index];
        } else {
          value = "NA";
          break;
        }
      } else {
        // normal property access
        if (value && value[part] !== undefined) {
          value = value[part];
        } else {
          value = "NA";
          break;
        }
      }
    }

    if (typeof value === "object" && value !== null) {
      value = JSON.stringify(value);
    }

    result[variable.varName] = value;
  });

  return result;
}

const matchCondition = (conditions, incomingText) => {
  // Loop through each condition
  for (let condition of conditions) {
    const { type, value, caseSensitive } = condition;

    // Adjust value and incomingText based on caseSensitive flag
    const processedValue = caseSensitive ? value : value.toLowerCase();
    const processedText = caseSensitive
      ? incomingText
      : incomingText.toLowerCase();

    switch (type) {
      case "text_exact":
        if (processedText === processedValue) {
          return condition; // Exact match
        }
        break;
      case "text_contains":
        if (processedText.includes(processedValue)) {
          return condition; // Text contains condition
        }
        break;
      case "text_starts_with":
        if (processedText.startsWith(processedValue)) {
          return condition; // Text starts with condition
        }
        break;
      case "text_ends_with":
        if (processedText.endsWith(processedValue)) {
          return condition; // Text ends with condition
        }
        break;
      case "number_equals":
        if (Number(processedText) === Number(processedValue)) {
          return condition; // Number equality condition
        }
        break;
      case "number_greater":
        if (Number(processedText) > Number(processedValue)) {
          return condition; // Greater than condition
        }
        break;
      case "number_less":
        if (Number(processedText) < Number(processedValue)) {
          return condition; // Less than condition
        }
        break;
      case "number_between":
        const [min, max] = processedValue
          .split(",")
          .map((num) => Number(num.trim()));
        if (Number(processedText) >= min && Number(processedText) <= max) {
          return condition; // Number between condition
        }
        break;
      default:
        break;
    }
  }
  return null; // Return null if no condition matched
};

function extractBodyText(message) {
  const messageBody =
    message?.msgContext?.text?.body ||
    message?.msgContext?.interactive?.body?.text ||
    (message?.msgContext?.image &&
      `img:${message?.msgContext?.image?.link}|${message?.msgContext?.image?.caption}`) ||
    (message?.msgContext?.image &&
      `img:${message?.msgContext?.image?.link}|${message?.msgContext?.image?.caption}`);
  message?.msgContext?.video?.caption ||
    message?.msgContext?.video?.link ||
    message?.msgContext?.document?.caption ||
    message?.msgContext?.reaction?.emoji ||
    message?.msgContext?.location ||
    message?.msgContext?.contact?.contacts?.[0]?.name?.formatted_name;

  return messageBody;
}

function timeoutPromise(promise, ms) {
  const timeout = new Promise(
    (resolve) => setTimeout(() => resolve(null), ms), // Instead of rejecting, resolve null
  );
  return Promise.race([promise, timeout]);
}

function replaceVariables(input, variables = {}) {
  if (input === null || input === undefined) return input;

  if (typeof input === "string") {
    return input.replace(/\{\{\{([^{}]+)\}\}\}/g, (match, expression) => {
      try {
        // Check if it's a plain path like items[0].name
        const plainPath = expression.match(/^([a-zA-Z0-9_$\[\]\.]+)$/);
        if (plainPath) {
          const parts = expression.split(/[\.\[\]]/).filter(Boolean);
          let value = variables;
          for (const part of parts) {
            if (value === undefined || value === null) return match;
            if (part in value) {
              value = value[part];
            } else if (!isNaN(part)) {
              value = value[parseInt(part)];
            } else {
              return match;
            }
          }
          return value !== undefined ? value : match;
        } else {
          // Evaluate full JS expression
          const func = new Function(
            ...Object.keys(variables),
            `return ${expression}`,
          );
          return func(...Object.values(variables));
        }
      } catch (e) {
        return match; // Fallback to original if error
      }
    });
  }

  if (Array.isArray(input)) {
    return input.map((item) => replaceVariables(item, variables));
  }

  if (typeof input === "object") {
    const result = {};
    for (const [k, v] of Object.entries(input)) {
      result[k] = replaceVariables(v, variables);
    }
    return result;
  }

  return input;
}

async function sendWaMessage({
  origin,
  node,
  sessionId,
  message,
  isGroup = false,
  uid,
  variablesObj,
  content = null,
}) {
  try {
    let sendMsgId = null;
    const messageContent = content || node?.data?.content;
    const messageType = messageContent?.type;

    // ✅ Check if it's a media message for Meta API
    const isMediaMessage = ["image", "video", "document", "audio"].includes(
      messageType,
    );

    // ✅ TELEGRAM SUPPORT
    if (origin === "telegram") {
      const {
        sendMessageTelegram,
      } = require("../helper/addon/telegram/processTelegramInbox");

      // Get chat info from beta_chats
      const [chatInfo] = await query(
        `SELECT * FROM beta_chats WHERE sender_mobile = ? AND uid = ? LIMIT 1`,
        [message.senderMobile, uid],
      );

      if (!chatInfo) {
        console.error("❌ Chat info not found for Telegram message");
        return null;
      }

      const result = await sendMessageTelegram({
        uid,
        to: message.senderMobile, // This should be in format "123456789@telegram"
        msgObj: messageContent,
        chatInfo,
      });

      sendMsgId = result?.id || null;
    }
    // QR (Baileys)
    else if (origin === "qr") {
      const {
        getSession,
        formatGroup,
        formatPhone,
      } = require("../helper/addon/qr/index");

      const convertMsgToQR = setQrMsgObj(messageContent);
      const session = await timeoutPromise(getSession(sessionId || "a"), 60000);
      if (!session) {
        sendMsgId = null;
      } else {
        const jid = isGroup
          ? formatGroup(message.senderMobile)
          : formatPhone(message.senderMobile);

        const send = await timeoutPromise(
          session?.sendMessage(jid, convertMsgToQR),
          60000,
        );

        sendMsgId = send?.key?.id || null;
      }
    }
    // Webhook with QR origin
    else if (
      origin === "webhook_automation" &&
      node?.data?.webhook?.origin?.code === "QR"
    ) {
      const {
        getSession,
        formatGroup,
        formatPhone,
      } = require("../helper/addon/qr/index");

      const convertMsgToQR = setQrMsgObj(messageContent);
      const session = await timeoutPromise(
        getSession(node?.data?.webhook?.origin?.data?.uniqueId || "a"),
        60000,
      );
      if (!session) {
        sendMsgId = null;
      } else {
        const jid = isGroup
          ? formatGroup(message.senderMobile)
          : formatPhone(message.senderMobile);

        const send = await timeoutPromise(
          session?.sendMessage(jid, convertMsgToQR),
          60000,
        );

        sendMsgId = send?.key?.id || null;
      }
    }
    // ✅ Webhook with Telegram origin
    else if (
      origin === "webhook_automation" &&
      node?.data?.webhook?.origin?.code === "TELEGRAM"
    ) {
      const {
        sendMessageTelegram,
      } = require("../helper/addon/telegram/processTelegramInbox");

      const [chatInfo] = await query(
        `SELECT * FROM beta_chats WHERE sender_mobile = ? AND uid = ? LIMIT 1`,
        [message.senderMobile, uid],
      );

      if (!chatInfo) {
        console.error("❌ Chat info not found for Telegram webhook");
        return null;
      }

      const result = await sendMessageTelegram({
        uid,
        to: message.senderMobile,
        msgObj: messageContent,
        chatInfo,
      });

      sendMsgId = result?.id || null;
    }
    // Webhook with Meta origin
    else if (
      origin === "webhook_automation" &&
      node?.data?.webhook?.origin?.code === "META"
    ) {
      // ✅ Use media upload function for media messages
      if (isMediaMessage) {
        const send = await sendMetaMsgWithMediaUpload({
          msgObj: messageContent,
          to: message.senderMobile,
          uid,
        });
        sendMsgId = send?.id || null;
      } else {
        // Use regular function for text/interactive messages
        const send = await sendMetaMsg({
          msgObj: messageContent,
          to: message.senderMobile,
          uid,
        });
        sendMsgId = send?.id || null;
      }
    }
    // Default Meta
    else {
      // ✅ Use media upload function for media messages
      if (isMediaMessage) {
        console.log(`📤 Using media upload function for ${messageType}`);
        const send = await sendMetaMsgWithMediaUpload({
          msgObj: messageContent,
          to: message.senderMobile,
          uid,
        });
        sendMsgId = send?.id || null;
      } else {
        // Use regular function for text/interactive messages
        const send = await sendMetaMsg({
          msgObj: messageContent,
          to: message.senderMobile,
          uid,
        });
        sendMsgId = send?.id || null;
      }
    }

    return sendMsgId;
  } catch (err) {
    console.log(err);
    return null;
  }
}

async function getActiveFlows({ uid, origin, sessionId, webhook }) {
  try {
    const [user] = await query(`SELECT plan FROM user WHERE uid = ?`, [uid]);

    if (!user?.plan) return [];

    const plan = JSON.parse(user.plan);
    if (plan.allow_chatbot <= 0) return [];

    let chatbots = [];

    if (origin?.toLowerCase() === "qr" && sessionId) {
      chatbots = await query(
        `SELECT flow_id, uid, origin_id FROM beta_chatbot 
         WHERE uid = ? AND origin_id = ? AND active = 1`,
        [uid, sessionId],
      );
    } else if (origin?.toLowerCase() === "telegram" && sessionId) {
      chatbots = await query(
        `SELECT flow_id, uid, origin_id FROM beta_chatbot 
         WHERE uid = ? AND origin_id = ? AND active = 1`,
        [uid, sessionId],
      );
    } else if (origin?.toLowerCase() === "webhook_automation") {
      chatbots = await query(
        `SELECT flow_id, uid, origin_id, origin FROM beta_chatbot 
         WHERE uid = ? AND source = ? AND active = 1 
         AND origin LIKE ?`,
        [uid, "webhook_automation", `%"webhook_id":"${webhook?.webhook_id}"%`],
      );
    } else if (origin?.toLowerCase() === "meta") {
      chatbots = await query(
        `SELECT flow_id, uid, origin_id FROM beta_chatbot 
         WHERE uid = ? AND origin_id = ? AND active = 1`,
        [uid, "META"],
      );
    }

    if (chatbots?.length < 1) {
      return [];
    }

    // Optimize with IN clause instead of multiple queries
    const flowIds = chatbots.map((c) => c.flow_id);
    const sourceType =
      origin?.toLowerCase() === "webhook_automation"
        ? "webhook_automation"
        : "wa_chatbot";

    const flows = await query(
      `SELECT * FROM beta_flows 
       WHERE uid = ? AND is_active = 1 AND source = ? 
       AND flow_id IN (?)`,
      [uid, sourceType, flowIds],
    );

    // Map flows to chatbots
    const flowMap = new Map(flows.map((f) => [f.flow_id, f]));
    return chatbots
      .map((chatbot) => {
        const flow = flowMap.get(chatbot.flow_id);
        return flow ? { ...flow, ...chatbot } : null;
      })
      .filter(Boolean);
  } catch (err) {
    console.error("Error in getActiveFlows:", err);
    throw err;
  }
}

async function getFlowSession({
  flowId,
  message,
  uid,
  nodes = [],
  incomingText,
  edges = [],
  sessionId,
  origin,
  webhookVariables = {},
}) {
  try {
    if (!message?.senderMobile) return null;

    // Single query with proper index usage
    let [flowSession] = await query(
      `SELECT id, data FROM flow_session 
       WHERE uid = ? AND flow_id = ? AND sender_mobile = ?
       LIMIT 1`,
      [uid, flowId, message.senderMobile],
    );

    if (!flowSession) {
      const initialFlow = nodes.find((n) => n.id === "initialNode");
      const getEdge = edges.find((e) => e.source === initialFlow?.id);
      const getNode = nodes.find((n) => n.id === getEdge?.target);

      if (!getNode) return null;

      const sessionData = JSON.stringify({
        variables: {
          senderMobile: message.senderMobile,
          senderName: message.senderName,
          senderMessage: incomingText,
          ...webhookVariables,
        },
        node: getNode,
      });

      // Insert and get ID in one operation
      const result = await query(
        `INSERT INTO flow_session (uid, origin, origin_id, flow_id, sender_mobile, data) 
         VALUES (?,?,?,?,?,?)`,
        [uid, origin, sessionId, flowId, message.senderMobile, sessionData],
      );

      flowSession = {
        id: result.insertId,
        data: sessionData,
      };
    }

    if (!flowSession) return null;

    const fData = JSON.parse(flowSession.data);
    let variablesObj = fData?.variables || {};
    variablesObj.senderMobile = message.senderMobile;
    variablesObj.senderName = message.senderName;
    variablesObj.senderMessage = incomingText;
    fData.variables = { ...variablesObj, ...webhookVariables };

    const updatingNode = nodes.find((x) => x.id === fData?.node?.id);

    return {
      id: flowSession.id,
      data: { ...fData, node: updatingNode },
    };
  } catch (err) {
    console.error("Error in getFlowSession:", err);
    return null;
  }
}

async function uploadMediaToMeta(mediaUrl, uid) {
  try {
    const [user] = await query(`SELECT * FROM user WHERE uid = ? LIMIT 1`, [
      uid,
    ]);

    if (!user?.meta_token) {
      throw new Error("Meta token not found");
    }

    // Download media from your server
    const mediaResponse = await fetch(mediaUrl);
    const mediaBuffer = await mediaResponse.buffer();
    const contentType = mediaResponse.headers.get("content-type");

    // Upload to Meta
    const FormData = require("form-data");
    const form = new FormData();
    form.append("file", mediaBuffer, {
      contentType: contentType,
      filename: "media_file",
    });
    form.append("messaging_product", "whatsapp");

    const uploadResponse = await fetch(
      `https://graph.facebook.com/v21.0/${user.meta_phone_id}/media`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.meta_token}`,
          ...form.getHeaders(),
        },
        body: form,
      },
    );

    const result = await uploadResponse.json();

    if (result.id) {
      console.log("✅ Media uploaded to Meta:", result.id);
      return { success: true, mediaId: result.id };
    } else {
      console.error("❌ Meta media upload failed:", result);
      return { success: false, error: result };
    }
  } catch (err) {
    console.error("Error uploading media to Meta:", err);
    return { success: false, error: err.message };
  }
}

async function processSendMessage({
  node,
  sessionId,
  user,
  message,
  chatId,
  origin,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
}) {
  try {
    const uid = user?.uid;

    const sendMsg = await sendWaMessage({
      message,
      node,
      origin,
      sessionId,
      isGroup: false,
      uid,
    });

    const userTimezone = getCurrentTimestampInTimeZone(
      user?.timezone || "Asia/Kolkata",
    );

    if (sendMsg) {
      const messageData = {
        type: node?.data?.type?.type,
        metaChatId: sendMsg,
        msgContext: node?.data?.content,
        reaction: "",
        timestamp: parseInt(userTimezone) + 1,
        senderName: message.senderName,
        senderMobile: message.senderMobile,
        star: 0,
        route: "OUTGOING",
        context: null,
        origin: origin,
      };

      await saveMessageToConversation({
        uid: uid,
        chatId,
        messageData,
        sentBy: "bot",
      });

      await query(
        `UPDATE beta_chats SET last_message = ? WHERE chat_id = ? AND uid = ?`,
        [JSON.stringify(messageData), chatId, uid],
      );

      // finding new id
      const e = edges.find((e) => e.source === node.id);
      if (!e) return {};
      const n = nodes.find((n) => n.id === e.target);

      if (n) {
        const oldData = flowSession?.data;
        const newData = { ...oldData, node: n };
        await query(
          `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
          [
            JSON.stringify(newData),
            element?.flow_id,
            uid,
            message?.senderMobile,
          ],
        );
        return { moveToNextNode: node?.data?.moveToNextNode || false };
      } else {
        return {};
      }
    } else {
      return {};
    }
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processCondition({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    let incomingText;
    if (node?.data.variable?.active) {
      incomingText = replaceVariables(
        node?.data.variable?.message,
        variablesObj,
      );
    } else {
      incomingText = incomingTextOld;
    }

    const getCondition = matchCondition(
      node?.data?.conditions || [],
      incomingText,
    );

    if (getCondition) {
      const e =
        edges?.find((e) => e.sourceHandle === getCondition?.targetNodeId) || {};
      const n = nodes?.find((n) => n.id === e?.target);
      if (n) {
        const oldData = flowSession?.data;
        const newData = { ...oldData, node: n };
        await query(
          `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
          [
            JSON.stringify(newData),
            element?.flow_id,
            uid,
            message?.senderMobile,
          ],
        );
      }
    } else {
      // process default condition if not matched
      const e =
        edges?.find(
          (e) => e.source === node?.id && e.sourceHandle === "default",
        ) || {};
      const n = nodes?.find((n) => n.id === e?.target);
      if (n) {
        const oldData = flowSession?.data;
        const newData = { ...oldData, node: n };
        await query(
          `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
          [
            JSON.stringify(newData),
            element?.flow_id,
            uid,
            message?.senderMobile,
          ],
        );
      }
    }

    return { moveToNextNode: node?.data?.moveToNextNode };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processResponseSaver({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const newVars = node?.data?.variables || [];
    const convertVar = setVariables(newVars, { message });
    const savingVars = { ...(variablesObj || {}), ...(convertVar || {}) };

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};

    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const newData = {
      ...(flowSession?.data || {}),
      node: n,
      variables: savingVars,
    };

    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile],
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.error("Error in processResponseSaver:", err);
    return {};
  }
}

async function checkIfChatDisabled({ flowSession }) {
  try {
    const tS = flowSession?.data?.disableChat?.timestamp || 0;
    let currentTime = new Date().getTime();
    return tS > currentTime;
  } catch (err) {
    console.log(err);
    return false;
  }
}

async function processDisableAutoReply({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const { hours, minutes } = node.data;
    const old = flowSession?.data;
    const timeStamp = addDurationToTimestamp(
      parseInt(hours) || 0,
      parseInt(minutes) || 0,
    );
    const newData = {
      ...old,
      disableChat: { node, timestamp: timeStamp },
    };

    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile],
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processMakeRequest({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const config = node.data;
    const resp = await makeRequestBeta(config, variablesObj);
    let allVars;

    if (resp.success) {
      const oldVars = flowSession?.data?.variables;
      const varFromReq = mapVariablesToResponse(
        node?.data?.variables || [],
        resp.data,
      );
      allVars = { ...oldVars, ...varFromReq };
    } else {
      allVars = flowSession?.data?.variables;
    }

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};

    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const newData = {
      ...(flowSession?.data || {}),
      node: n,
      variables: allVars,
    };

    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile],
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

// async function processDelay({
//   chatId,
//   message,
//   node,
//   origin,
//   sessionId,
//   user,
//   nodes,
//   edges,
//   flowSession,
//   element,
//   variablesObj,
//   incomingText: incomingTextOld,
// }) {
//   try {
//     const { uid } = user;
//     const { seconds } = node.data;
//     console.log(`Message waiting for ${seconds} sec`);
//     await delay(seconds || 0);

//     const e = edges.find((e) => e.source === node.id);
//     if (!e) return {};
//     const n = nodes.find((n) => n.id === e.target);
//     if (!n) return {};

//     const oldData = flowSession?.data;
//     const newData = { ...oldData, node: n };
//     await query(
//       `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
//       [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile],
//     );

//     return { moveToNextNode: node?.data?.moveToNextNode || false };
//   } catch (err) {
//     console.log(err);
//     return {};
//   }
// }

async function processDelay({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const { seconds } = node.data;

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};
    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const oldData = flowSession?.data;
    const newData = { ...oldData, node: n };

    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ? LIMIT 1`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile],
    );

    // Schedule execution without blocking the current flow
    setTimeout(async () => {
      try {
        // Get fresh user data
        const [updatedUser] = await query(
          `SELECT * FROM user WHERE uid = ? LIMIT 1`,
          [uid],
        );

        if (!updatedUser) {
          console.log("User not found for delayed execution");
          return;
        }

        // Re-import to avoid circular dependency issues
        const automationModule = require("./automation");

        await automationModule.processFlow({
          nodes,
          edges,
          uid,
          flowId: element.flow_id,
          message,
          incomingText: incomingTextOld,
          user: updatedUser,
          sessionId,
          origin,
          chatId,
          element,
          webhookVariables: {},
          loopDetection: { visitedNodes: new Map(), startTime: Date.now() },
        });
      } catch (err) {
        console.error("Error in delayed execution:", err);
      }
    }, seconds * 1000);

    // Return false to stop current execution chain
    return { moveToNextNode: false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processSpreadSheet({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const { authUrl, authLabel, jsonData, sheetName, sheetId } = node.data;

    if (authUrl && authLabel && jsonData && sheetName && sheetId) {
      await pushSpreadSheet({
        authUrl,
        sheetName,
        sheetId,
        jsonData: replaceJsonWithVar(jsonData, variablesObj),
      });
    }

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};
    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const oldData = flowSession?.data;
    const newData = { ...oldData, node: n };
    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile],
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processSendEmail({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const {
      host,
      port,
      email,
      pass,
      username,
      from,
      to,
      subject,
      html,
      security,
      useAuth,
    } = node.data;

    await sendEmailBeta({
      host,
      port,
      email,
      pass,
      username,
      from,
      to: replaceVarFromString(to, variablesObj),
      subject: replaceVarFromString(subject, variablesObj),
      html: replaceVarFromString(html, variablesObj),
      security,
      useAuth,
    });

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};
    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const oldData = flowSession?.data;
    const newData = { ...oldData, node: n };
    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile],
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processAgentTransfer({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const { agentData, autoAgentSelect, toAll } = node.data;

    let agentNewData = null;

    if (toAll) {
      // Assign to all active agents
      const allAgents = await query(
        `SELECT * FROM agents WHERE owner_uid = ? AND is_active = ?`,
        [uid, 1],
      );

      if (allAgents?.length > 0) {
        agentNewData = allAgents; // This will be an array of all agents
      } else {
        return { moveToNextNode: node?.data?.moveToNextNode || false };
      }
    } else if (autoAgentSelect) {
      // Auto-select a random single agent
      const agents = await query(
        `SELECT * FROM agents WHERE owner_uid = ? AND is_active = ?`,
        [uid, 1],
      );

      if (agents?.length > 0) {
        const randomAgent = agents[Math.floor(Math.random() * agents.length)];
        agentNewData = [randomAgent]; // Wrap in array for consistency
      } else {
        return { moveToNextNode: node?.data?.moveToNextNode || false };
      }
    } else {
      // Manual agent selection
      const [findAgent] = await query(
        `SELECT * FROM agents WHERE owner_uid = ? AND uid = ?`,
        [uid, agentData?.uid],
      );

      if (findAgent) {
        agentNewData = [findAgent]; // Wrap in array for consistency
      }
    }

    if (agentNewData) {
      // Convert to array if it isn't already (backward compatibility)
      const agentsArray = Array.isArray(agentNewData)
        ? agentNewData
        : [agentNewData];

      await query(
        `UPDATE beta_chats SET assigned_agent = ? WHERE uid = ? AND chat_id = ?`,
        [JSON.stringify(agentsArray), uid, chatId],
      );
    }

    // ____

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};
    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    const oldData = flowSession?.data;
    const newData = { ...oldData, node: n };
    await query(
      `UPDATE flow_session SET data = ? WHERE flow_id = ? AND uid = ? AND sender_mobile = ?`,
      [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile],
    );

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processAiTransfer({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const config = node.data;

    if (config?.assignedToAi) {
      let a = flowSession?.data || {};
      a.aiTransfer = { active: true, node: node };
      await query(
        `UPDATE flow_session 
         SET data = ? 
         WHERE flow_id = ? AND uid = ? AND sender_mobile = ?
         LIMIT 1`,
        [JSON.stringify(a), element?.flow_id, uid, message?.senderMobile],
      );
    } else {
      const e = edges.find((e) => e.source === node.id);
      if (!e) return {};
      const n = nodes.find((n) => n.id === e.target);
      if (!n) return {};

      const oldData = flowSession?.data;
      const newData = { ...oldData, node: n };
      await query(
        `UPDATE flow_session 
         SET data = ? 
         WHERE flow_id = ? AND uid = ? AND sender_mobile = ?
         LIMIT 1`,
        [JSON.stringify(newData), element?.flow_id, uid, message?.senderMobile],
      );
    }

    // Optimize: Only select needed columns and use proper index
    let conversationArr = await query(
      `SELECT type, msgContext, route, timestamp 
       FROM beta_conversation 
       WHERE chat_id = ? AND uid = ? AND route = 'INCOMING' 
       ORDER BY timestamp DESC 
       LIMIT ?`,
      [chatId, uid, node?.data?.messageReferenceCount || 1],
    );

    conversationArr = [...conversationArr]?.reverse() || [];

    const result = await aiTransferHandler(config, conversationArr);

    console.dir({ result }, { depth: null });

    if (result?.data?.message || result?.message) {
      const sendMsg = await sendWaMessage({
        message,
        node: {},
        origin,
        sessionId,
        isGroup: false,
        uid,
        content: {
          type: "text",
          text: {
            preview_url: true,
            body: result?.data?.message || result?.message,
          },
        },
      });

      const userTimezone = getCurrentTimestampInTimeZone(
        user?.timezone || "Asia/Kolkata",
      );

      if (sendMsg) {
        const messageData = {
          type: "text",
          metaChatId: sendMsg,
          msgContext: {
            type: "text",
            text: {
              preview_url: true,
              body: result?.data?.message || result?.message,
            },
          },
          reaction: "",
          timestamp: parseInt(userTimezone) + 1,
          senderName: message.senderName,
          senderMobile: message.senderMobile,
          star: 0,
          route: "OUTGOING",
          context: null,
          origin: origin,
          sentBy: "ai",
        };

        await saveMessageToConversation({
          uid: uid,
          chatId,
          messageData,
          sentBy: "ai",
        });

        await query(
          `UPDATE beta_chats 
           SET last_message = ? 
           WHERE chat_id = ? AND uid = ?
           LIMIT 1`,
          [JSON.stringify(messageData), chatId, uid],
        );

        return {};
      } else {
        return {};
      }
    } else if (result?.data?.function?.length > 0) {
      const functionObj = result?.data?.function[0];
      const functionId = functionObj?.id;

      const e = edges?.find((e) => e.sourceHandle === functionId) || {};
      const n = nodes?.find((n) => n.id === e?.target);

      if (!n) return { moveToNextNode: node?.data?.moveToNextNode };

      if (n) {
        const oldData = flowSession?.data;
        const newData = {
          ...oldData,
          node: n,
          aiTransfer: { active: false, node: null },
        };
        await query(
          `UPDATE flow_session 
           SET data = ? 
           WHERE flow_id = ? AND uid = ? AND sender_mobile = ?
           LIMIT 1`,
          [
            JSON.stringify(newData),
            element?.flow_id,
            uid,
            message?.senderMobile,
          ],
        );
      }
      return { moveToNextNode: true };
    } else {
      console.dir({ result }, { depth: null });
    }
  } catch (err) {
    console.log(err);
    return {};
  }
}

async function processMysqlQuery({
  chatId,
  message,
  node,
  origin,
  sessionId,
  user,
  nodes,
  edges,
  flowSession,
  element,
  variablesObj,
  incomingText: incomingTextOld,
}) {
  try {
    const { uid } = user;
    const { seconds } = node.data;

    let mysqlVars = {};
    const replaceVars = replaceJsonWithVarsNew(node.data, variablesObj);
    const resp = await executeMySQLQuery(replaceVars);

    if (resp.success) {
      mysqlVars = setVariables(node?.data?.variables || [], {
        response: resp.data,
      });
    }

    await pushNewKeyInData({
      key: "variables",
      pushObj: mysqlVars,
      flowSession,
    });

    const e = edges.find((e) => e.source === node.id);
    if (!e) return {};
    const n = nodes.find((n) => n.id === e.target);
    if (!n) return {};

    await pushNewKeyInData({
      key: "node",
      pushObj: n,
      flowSession,
    });

    return { moveToNextNode: node?.data?.moveToNextNode || false };
  } catch (err) {
    console.log(err);
    return {};
  }
}

function getNestedValue(path, obj) {
  if (
    typeof path !== "string" ||
    !path ||
    typeof obj !== "object" ||
    obj === null
  ) {
    return null;
  }

  // Remove {{ }}, {{{ }}}, spaces
  path = path.replace(/^\{\{\{?|\}?\}\}$/g, "").trim();

  return path.split(".").reduce((acc, key) => {
    if (acc === null || acc === undefined) return null;

    // handle numeric array index
    if (Array.isArray(acc) && !isNaN(key)) {
      return acc[Number(key)] ?? null;
    }

    if (typeof acc === "object" && key in acc) {
      return acc[key];
    }

    return null;
  }, obj);
}

module.exports = {
  extractBodyText,
  getActiveFlows,
  getFlowSession,
  processSendMessage,
  replaceVariables,
  processCondition,
  processResponseSaver,
  processDisableAutoReply,
  checkIfChatDisabled,
  processMakeRequest,
  processDelay,
  processSpreadSheet,
  processSendEmail,
  processAgentTransfer,
  processAiTransfer,
  processMysqlQuery,
  getNestedValue,
  sendMetaMsgWithMediaUpload,
};
