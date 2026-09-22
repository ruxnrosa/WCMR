const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const randomstring = require("randomstring");
const bcrypt = require("bcrypt");
const {
  isValidEmail,
  getFileExtension,
  saveJsonToFile,
  saveWebhookConversation,
  readJSONFile,
  sendMetaMsg,
  mergeArrays,
  botWebhook,
  sendMetatemplet,
  updateMetaTempletInMsg,
  getUserPlayDays,
  deleteFileIfExists,
  importChatsFromv3,
  importConversationsFromJson,
  parseJson,
} = require("../functions/function.js");
const { sign } = require("jsonwebtoken");
const validateUser = require("../middlewares/user.js");
const { getIOInstance } = require("../socket.js");
const { checkPlan } = require("../middlewares/plan.js");
const { processMessage } = require("../helper/inbox/inbox.js");
const con = require("../database/config.js");
const { updateMessageStatus } = require("../loops/campaignBeta.js");
const {
  updateMessageStatus: updateMessageStatusAPI,
} = require("../functions/apiMessages");

const { handleCalls } = require("../helper/addon/wacall/wacall.js");
const {
  handleBroadcastCallConnect,
  handleBroadcastCallTerminate,
  outgoingCallStates,
} = require("../helper/addon/wacall/broadcastProcessor.js");

// WhatsApp Webhook Verification
router.get("/embed/webhook/:uid", async (req, res) => {
  try {
    const [admin] = await query(`SELECT uid FROM admin LIMIT 1`);
    if (!admin) {
      return res.sendStatus(400);
    }

    const VERIFY_TOKEN = admin.uid;

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (!mode || !token) {
      return res.sendStatus(400);
    }

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ WHATSAPP WEBHOOK VERIFIED");
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  } catch (err) {
    console.error(err);
    return res.sendStatus(500);
  }
});

// handle embed webhook
router.post("/embed/webhook/:uid", async (req, res) => {
  try {
    const body = req.body;
    res.sendStatus(200);
    const statuses = body?.entry?.[0]?.changes?.[0]?.value?.statuses;

    console.log(JSON.stringify({ body }));

    // Handle message status updates - SIMPLE VERSION
    if (req.body && req.body.entry) {
      for (const entry of req.body.entry) {
        if (entry.changes) {
          for (const change of entry.changes) {
            if (change.value && change.value.statuses) {
              for (const status of change.value.statuses) {
                if (status.id) {
                  // Call the updateMessageStatus function
                  await updateMessageStatus(
                    status.id,
                    status.status, // delivered, read, sent, failed
                  );
                }
              }
            }
          }
        }
      }
    }

    console.log("1");

    // updating API logs
    if (statuses?.length > 0) {
      const { status, id } = statuses[0];
      const errorData = JSON.stringify(body);

      if (status === "failed") {
        await query(
          `UPDATE beta_api_logs SET status = ?, err = ? WHERE msg_id = ?`,
          [status, errorData, id],
        );
      } else if (id) {
        await query(`UPDATE beta_api_logs SET status = ? WHERE msg_id = ?`, [
          status,
          id,
        ]);
      }
    }

    if (statuses?.length > 0) {
      const { status, id } = statuses[0];
      const errorData = JSON.stringify(body);

      if (status === "failed") {
        await query(
          `UPDATE beta_campaign_logs SET delivery_status = ?, error_message = ? WHERE meta_msg_id = ?`,
          [status, errorData, id],
        );
      } else if (id) {
        await query(
          `UPDATE beta_campaign_logs SET delivery_status = ? WHERE meta_msg_id = ?`,
          [status, id],
        );
      }
    }

    console.log("2");

    const changes = body?.entry[0]?.changes[0];
    const phoneNumId = changes?.value?.metadata?.phone_number_id;
    const wabaId = body?.entry[0]?.id;

    console.log("3");

    let userUID = null;

    if (phoneNumId) {
      const getMyMetaApi = await query(
        `SELECT * FROM meta_api WHERE JSON_EXTRACT(embed_data, '$.waba.id') = ?`,
        [wabaId],
      );

      userUID = getMyMetaApi[0]?.uid;
      const getDays = await getUserPlayDays(userUID);
      if (getDays < 1) {
        console.log("User plan expired");
        return;
      }

      if (getMyMetaApi?.length > 0) {
        const myNumberId = getMyMetaApi[0]?.business_phone_number_id;
        if (phoneNumId !== myNumberId) {
          return;
        }
      }
    }

    console.log("4");

    if (!userUID) return;

    // ✅ Handle different webhook types
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];

    if (!change) {
      console.log("⚠️ No change data");
      return;
    }

    switch (change.field) {
      case "messages":
        // save message
        await processMessage({
          body,
          uid: userUID,
          origin: "meta",
        });

        // Handle call permission replies for broadcasts
        const messages = change.value?.messages || [];
        for (const message of messages) {
          if (
            message.type === "interactive" &&
            message.interactive?.type === "call_permission_reply"
          ) {
            const reply = message.interactive.call_permission_reply;
            const fromNumber = message.from;

            console.log(`📞 Call permission reply from ${fromNumber}:`, reply);

            if (reply.response === "accept") {
              await updateBroadcastContactPermission(
                fromNumber,
                "granted",
                reply,
              );
            } else if (reply.response === "reject") {
              await updateBroadcastContactPermission(
                fromNumber,
                "denied",
                reply,
              );
            }
          }
        }
        break;

      case "calls":
        const callEvents = change.value.calls || [];
        const callStatuses = change.value.statuses || [];

        for (const callEvent of callEvents) {
          const callId = callEvent.id;

          // ✅ Get callback data properly
          const callbackData = callEvent.biz_opaque_callback_data;

          console.log(`🔍 [${callId}] Call event:`, callEvent.event);
          console.log(`🔍 [${callId}] Callback data:`, callbackData);

          // ✅ Check if this is a broadcast call by checking callback data
          let isBroadcastCall = false;
          let parsedCallbackData = null;

          if (callbackData) {
            try {
              parsedCallbackData = JSON.parse(callbackData);
              isBroadcastCall = !!parsedCallbackData.campaign_id;
              console.log(
                `🔍 [${callId}] Parsed callback:`,
                parsedCallbackData,
              );
              console.log(`🔍 [${callId}] Is broadcast call:`, isBroadcastCall);
            } catch (e) {
              console.error(`❌ [${callId}] Failed to parse callback data:`, e);
            }
          }

          if (isBroadcastCall) {
            console.log(`📞 [${callId}] Handling as broadcast call`);

            // Handle broadcast call events
            if (callEvent.event === "connect" && callEvent.session) {
              console.log(`📞 [${callId}] Broadcast call connect event`);
              await handleBroadcastCallConnect(
                callId,
                callEvent.session,
                callbackData,
              );
            }

            if (callEvent.event === "terminate") {
              console.log(`📞 [${callId}] Broadcast call terminate event`);
              await handleBroadcastCallTerminate(
                callId,
                callEvent.status,
                callEvent.duration,
                callbackData,
              );
            }
          } else {
            console.log(`📞 [${callId}] Handling as incoming call`);
            // Handle incoming calls (existing logic)
            await handleCalls(change, userUID, body);
          }
        }

        // Handle call status updates
        for (const status of callStatuses) {
          const callId = status.id;
          const isBroadcastCall = outgoingCallStates.has(callId);

          if (isBroadcastCall) {
            const callState = outgoingCallStates.get(callId);
            if (callState) {
              const { campaignId, contact } = callState;

              console.log(`📞 [${callId}] Status update:`, status.status);

              if (status.status === "REJECTED") {
                await updateContactInBroadcast(campaignId, contact.mobile, {
                  call_status: "rejected",
                });
              }
            }
          }
        }
        break;

      default:
        console.log(`⚠️ Unknown field: ${change.field}`);
        break;
    }
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

router.post("/webhook/:uid", async (req, res) => {
  try {
    const body = req.body;
    const userUID = req.params.uid;

    // ✅ ACK immediately
    res.sendStatus(200);

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];

    if (!change) {
      console.log("⚠️ No change data");
      return;
    }

    switch (change.field) {
      case "messages":
        await handleMessages(change, userUID, body);

        // Handle call permission replies for broadcasts
        const messages = change.value?.messages || [];
        for (const message of messages) {
          if (
            message.type === "interactive" &&
            message.interactive?.type === "call_permission_reply"
          ) {
            const reply = message.interactive.call_permission_reply;
            const fromNumber = message.from;

            console.log(`📞 Call permission reply from ${fromNumber}:`, reply);

            if (reply.response === "accept") {
              await updateBroadcastContactPermission(
                fromNumber,
                "granted",
                reply,
              );
            } else if (reply.response === "reject") {
              await updateBroadcastContactPermission(
                fromNumber,
                "denied",
                reply,
              );
            }
          }
        }
        break;

      case "calls":
        const callEvents = change.value.calls || [];
        const statuses = change.value.statuses || [];

        for (const callEvent of callEvents) {
          const callId = callEvent.id;

          // ✅ FIX: Get callback data properly
          const callbackData = callEvent.biz_opaque_callback_data;

          console.log(`🔍 [${callId}] Call event:`, callEvent.event);
          console.log(`🔍 [${callId}] Callback data:`, callbackData);

          // ✅ FIX: Check if this is a broadcast call by checking callback data
          let isBroadcastCall = false;
          let parsedCallbackData = null;

          if (callbackData) {
            try {
              parsedCallbackData = JSON.parse(callbackData);
              isBroadcastCall = !!parsedCallbackData.campaign_id;
              console.log(
                `🔍 [${callId}] Parsed callback:`,
                parsedCallbackData,
              );
              console.log(`🔍 [${callId}] Is broadcast call:`, isBroadcastCall);
            } catch (e) {
              console.error(`❌ [${callId}] Failed to parse callback data:`, e);
            }
          }

          if (isBroadcastCall) {
            console.log(`📞 [${callId}] Handling as broadcast call`);

            // Handle broadcast call events
            if (callEvent.event === "connect" && callEvent.session) {
              console.log(`📞 [${callId}] Broadcast call connect event`);
              await handleBroadcastCallConnect(
                callId,
                callEvent.session,
                callbackData,
              );
            }

            if (callEvent.event === "terminate") {
              console.log(`📞 [${callId}] Broadcast call terminate event`);
              await handleBroadcastCallTerminate(
                callId,
                callEvent.status,
                callEvent.duration,
                callbackData,
              );
            }
          } else {
            console.log(`📞 [${callId}] Handling as incoming call`);
            // Handle incoming calls (existing logic)
            await handleCalls(change, userUID, body);
          }
        }

        // Handle call status updates
        for (const status of statuses) {
          const callId = status.id;
          const isBroadcastCall = outgoingCallStates.has(callId);

          if (isBroadcastCall) {
            const callState = outgoingCallStates.get(callId);
            if (callState) {
              const { campaignId, contact } = callState;

              console.log(`📞 [${callId}] Status update:`, status.status);

              if (status.status === "REJECTED") {
                await updateContactInBroadcast(campaignId, contact.mobile, {
                  call_status: "rejected",
                });
              }
            }
          }
        }
        break;

      default:
        console.log(`⚠️ Unknown field: ${change.field}`);
        break;
    }
  } catch (err) {
    console.error("❌ Webhook error:", err);
  }
});

// Helper function to update broadcast contact permission
async function updateBroadcastContactPermission(mobile, status, reply) {
  try {
    console.log(`🔄 Updating permission for ${mobile} to ${status}...`);

    const broadcasts = await query(
      `SELECT * FROM wa_call_broadcasts WHERE status IN ('requesting_permissions', 'ready', 'running', 'draft')`,
    );

    let updated = false;

    for (const broadcast of broadcasts) {
      const contacts = JSON.parse(broadcast.contacts || "[]");
      const contactIndex = contacts.findIndex((c) => c.mobile === mobile);

      if (contactIndex !== -1) {
        if (
          ["pending", "requested"].includes(
            contacts[contactIndex].permission_status,
          )
        ) {
          contacts[contactIndex].permission_status = status;
          contacts[contactIndex].permission_granted_at =
            new Date().toISOString();

          if (status === "granted") {
            contacts[contactIndex].permission_type = reply.is_permanent
              ? "permanent"
              : "temporary";
            contacts[contactIndex].permission_expires_at =
              reply.expiration_timestamp
                ? new Date(reply.expiration_timestamp * 1000).toISOString()
                : null;
          }

          let statsUpdate = {};
          if (status === "granted") {
            statsUpdate.permission_granted =
              (broadcast.permission_granted || 0) + 1;
          } else if (status === "denied") {
            statsUpdate.permission_denied =
              (broadcast.permission_denied || 0) + 1;
          }

          let updateQuery = `UPDATE wa_call_broadcasts SET contacts = ?`;
          let updateParams = [JSON.stringify(contacts)];

          Object.keys(statsUpdate).forEach((key) => {
            updateQuery += `, ${key} = ?`;
            updateParams.push(statsUpdate[key]);
          });

          updateQuery += ` WHERE campaign_id = ?`;
          updateParams.push(broadcast.campaign_id);

          await query(updateQuery, updateParams);

          console.log(
            `✅ Updated permission for ${mobile} in campaign ${broadcast.campaign_id}`,
          );

          updated = true;
        }
      }
    }

    if (!updated) {
      console.log(`⚠️ No matching campaign found for ${mobile}`);
    }
  } catch (err) {
    console.error("❌ Error updating broadcast contact permission:", err);
  }
}

async function handleMessages(change, uid, body) {
  const value = change.value;

  // ✅ Check plan ONLY for messages
  const getDays = await getUserPlayDays(uid);
  if (getDays < 1) {
    console.log("User plan expired");
    return;
  }

  // Handle message status updates
  const statuses = value?.statuses;

  if (statuses && statuses.length > 0) {
    for (const status of statuses) {
      if (status.id) {
        await updateMessageStatus(status.id, status.status);
      }
    }

    // Update API logs
    const { status, id } = statuses[0];
    const errorData = JSON.stringify(body);

    if (status === "failed") {
      await query(
        `UPDATE beta_api_logs SET status = ?, err = ? WHERE msg_id = ?`,
        [status, errorData, id],
      );
    } else if (id) {
      await query(`UPDATE beta_api_logs SET status = ? WHERE msg_id = ?`, [
        status,
        id,
      ]);
    }

    // Update campaign logs
    if (status === "failed") {
      await query(
        `UPDATE beta_campaign_logs SET delivery_status = ?, error_message = ? WHERE meta_msg_id = ?`,
        [status, errorData, id],
      );
    } else if (id) {
      await query(
        `UPDATE beta_campaign_logs SET delivery_status = ? WHERE meta_msg_id = ?`,
        [status, id],
      );
    }
  }

  // Verify phone number
  if (value?.metadata?.phone_number_id) {
    const getMyMetaApi = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      uid,
    ]);

    if (getMyMetaApi?.length > 0) {
      const checkNumber = value.metadata.phone_number_id;
      const myNumberId = getMyMetaApi[0]?.business_phone_number_id;

      if (checkNumber !== myNumberId) {
        console.log("⚠️ Phone number mismatch");
        return;
      }
    }
  }

  // Save message
  await processMessage({
    body,
    uid,
    origin: "meta",
  });
}

// getting chat lists
router.get("/get_chats", validateUser, async (req, res) => {
  try {
    let data = [];
    data = await query(`SELECT * FROM chats WHERE uid = ?`, [req.decode.uid]);
    const getContacts = await query(`SELECT * FROM contact WHERE uid = ?`, [
      req.decode.uid,
    ]);

    if (data.length > 0 && getContacts.length > 0) {
      data = mergeArrays(getContacts, data);
    } else {
      data = data;
    }

    res.json({ data, success: true });
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

// get chat conversatio
router.post("/get_convo", validateUser, async (req, res) => {
  try {
    const { chatId } = req.body;

    const filePath = `${__dirname}/../conversations/inbox/${req.decode.uid}/${chatId}.json`;
    const data = readJSONFile(filePath, 100);
    res.json({ data, success: true });
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

// adding webhook
router.get("/webhook/:uid", async (req, res) => {
  try {
    const { uid } = req.params;

    const queryParan = req.query;
    const body = req.body;

    // console.log({ query: JSON.stringify(queryParan) });
    // console.log({ body: JSON.stringify(body) });

    const getUser = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);

    let verify_token = "";

    if (getUser.length < 1) {
      verify_token = "NULL";
      res.json({
        success: false,
        msg: "Token not verified",
        webhook: uid,
        token: "NOT FOUND",
      });
    } else {
      verify_token = uid;

      let mode = req.query["hub.mode"];
      let token = req.query["hub.verify_token"];
      let challenge = req.query["hub.challenge"];

      // Check if a token and mode were sent
      if (mode && token) {
        // Check the mode and token sent are correct
        if (mode === "subscribe" && token === verify_token) {
          // Respond with 200 OK and challenge token from the request
          console.log("WEBHOOK_VERIFIED");
          res.status(200).send(challenge);
        } else {
          // Responds with '403 Forbidden' if verify tokens do not match
          res.sendStatus(403);
        }
      } else {
        res.json({
          success: false,
          msg: "Token not verified",
          webhook: uid,
          token: "FOUND",
        });
      }
    }
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

router.get("/", async (req, res) => {
  try {
    const uid = "lWvj6K0xI0FlSKJoyV7ak9DN0mzvKJK8";
    const { msg } = req.query;

    // getting socket id
    const sock = await query(`SELECT * FROM rooms WHERE uid = ?`, [uid]);

    const io = getIOInstance();

    console.log(sock[0]?.socket_id);

    io.to(sock[0]?.socket_id).emit("update_conversations", "msg");

    res.json(msg);
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

// sending templets
router.post("/send_templet", validateUser, checkPlan, async (req, res) => {
  try {
    const { content, toName, toNumber, chatId, msgType } = req.body;

    if (!content || !toName || !toName || !msgType) {
      return res.json({ success: false, msg: "Invalid request" });
    }

    const msgObj = content;

    const savObj = {
      type: msgType,
      metaChatId: "",
      msgContext: content,
      reaction: "",
      timestamp: "",
      senderName: toName,
      senderMobile: toNumber,
      status: "sent",
      star: false,
      route: "OUTGOING",
    };

    const resp = await sendMetaMsg(
      req.decode.uid,
      msgObj,
      toNumber,
      savObj,
      chatId,
    );
    res.json(resp);
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

// send image
router.post("/send_image", validateUser, checkPlan, async (req, res) => {
  try {
    const { url, toNumber, toName, chatId, caption } = req.body;

    if (!url || !toNumber || !toName || !chatId) {
      return res.json({ success: false, msg: "Not enough input provided" });
    }

    const msgObj = {
      type: "image",
      image: {
        link: url,
        caption: caption || "",
      },
    };

    const savObj = {
      type: "image",
      metaChatId: "",
      msgContext: {
        type: "image",
        image: {
          link: url,
          caption: caption || "",
        },
      },
      reaction: "",
      timestamp: "",
      senderName: toName,
      senderMobile: toNumber,
      status: "sent",
      star: false,
      route: "OUTGOING",
    };

    const resp = await sendMetaMsg(
      req.decode.uid,
      msgObj,
      toNumber,
      savObj,
      chatId,
    );
    res.json(resp);
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

// send video
router.post("/send_video", validateUser, checkPlan, async (req, res) => {
  try {
    const { url, toNumber, toName, chatId, caption } = req.body;

    if (!url || !toNumber || !toName || !chatId) {
      return res.json({ success: false, msg: "Not enough input provided" });
    }

    const msgObj = {
      type: "video",
      video: {
        link: url,
        caption: caption || "",
      },
    };

    const savObj = {
      type: "video",
      metaChatId: "",
      msgContext: {
        type: "video",
        video: {
          link: url,
          caption: caption || "",
        },
      },
      reaction: "",
      timestamp: "",
      senderName: toName,
      senderMobile: toNumber,
      status: "sent",
      star: false,
      route: "OUTGOING",
    };

    const resp = await sendMetaMsg(
      req.decode.uid,
      msgObj,
      toNumber,
      savObj,
      chatId,
    );
    res.json(resp);
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

// send document
router.post("/send_doc", validateUser, checkPlan, async (req, res) => {
  try {
    const { url, toNumber, toName, chatId, caption } = req.body;

    if (!url || !toNumber || !toName || !chatId) {
      return res.json({ success: false, msg: "Not enough input provided" });
    }

    const msgObj = {
      type: "document",
      document: {
        link: url,
        caption: caption || "",
      },
    };

    const savObj = {
      type: "document",
      metaChatId: "",
      msgContext: {
        type: "document",
        document: {
          link: url,
          caption: caption || "",
        },
      },
      reaction: "",
      timestamp: "",
      senderName: toName,
      senderMobile: toNumber,
      status: "sent",
      star: false,
      route: "OUTGOING",
    };

    const resp = await sendMetaMsg(
      req.decode.uid,
      msgObj,
      toNumber,
      savObj,
      chatId,
    );
    res.json(resp);
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

// send audio
router.post("/send_audio", validateUser, checkPlan, async (req, res) => {
  try {
    const { url, toNumber, toName, chatId } = req.body;

    if (!url || !toNumber || !toName || !chatId) {
      return res.json({ success: false, msg: "Not enough input provided" });
    }

    const msgObj = {
      type: "audio",
      audio: {
        link: url,
      },
    };

    const savObj = {
      type: "audio",
      metaChatId: "",
      msgContext: {
        type: "audio",
        audio: {
          link: url,
        },
      },
      reaction: "",
      timestamp: "",
      senderName: toName,
      senderMobile: toNumber,
      status: "sent",
      star: false,
      route: "OUTGOING",
    };

    const resp = await sendMetaMsg(
      req.decode.uid,
      msgObj,
      toNumber,
      savObj,
      chatId,
    );
    res.json(resp);
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

// send text message
router.post("/send_text", validateUser, checkPlan, async (req, res) => {
  try {
    const { text, toNumber, toName, chatId } = req.body;

    if (!text || !toNumber || !toName || !chatId) {
      return res.json({ success: false, msg: "Not enough input provided" });
    }

    const msgObj = {
      type: "text",
      text: {
        preview_url: true,
        body: text,
      },
    };

    const savObj = {
      type: "text",
      metaChatId: "",
      msgContext: {
        type: "text",
        text: {
          preview_url: true,
          body: text,
        },
      },
      reaction: "",
      timestamp: "",
      senderName: toName,
      senderMobile: toNumber,
      status: "sent",
      star: false,
      route: "OUTGOING",
    };

    const resp = await sendMetaMsg(
      req.decode.uid,
      msgObj,
      toNumber,
      savObj,
      chatId,
    );
    res.json(resp);
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

// send meta templet
router.post("/send_meta_templet", validateUser, checkPlan, async (req, res) => {
  try {
    const { template, toNumber, toName, chatId, example } = req.body;

    if (!template) {
      return res.json({ success: false, msg: "Please type input" });
    }

    const getMETA = await query(`SELECT * FROM meta_api WHERE uid = ?`, [
      req.decode.uid,
    ]);
    if (getMETA.length < 1) {
      return res.json({
        success: false,
        msg: "Please check your meta API keys [1]",
      });
    }

    const resp = await sendMetatemplet(
      toNumber,
      getMETA[0]?.business_phone_number_id,
      getMETA[0]?.access_token,
      template,
      example,
    );

    if (resp.error) {
      console.log(resp);
      return res.json({
        success: false,
        msg: resp?.error?.error_user_title || "Please check your API",
      });
    } else {
      const savObj = {
        type: "text",
        metaChatId: "",
        msgContext: {
          type: "text",
          text: {
            preview_url: true,
            body: `{{TEMPLET_MESSAGE}} | ${template?.name}`,
          },
        },
        reaction: "",
        timestamp: "",
        senderName: toName,
        senderMobile: toNumber,
        status: "sent",
        star: false,
        route: "OUTGOING",
      };

      await updateMetaTempletInMsg(
        req.decode.uid,
        savObj,
        chatId,
        resp?.messages[0]?.id,
      );
      res.json({ success: true, msg: "The templet message was sent" });
    }
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

// del chat
router.post("/del_chat", validateUser, async (req, res) => {
  try {
    const { chatId } = req.body;
    await query(`DELETE FROM chats WHERE chat_id = ? AND uid = ?`, [
      chatId,
      req.decode.uid,
    ]);
    const filePath = `${__dirname}/../conversations/inbox/${req.decode.uid}/${chatId}`;

    deleteFileIfExists(filePath);

    res.json({ success: true, msg: "Conversation has been deleted" });
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

function groupChatsByNumberArrayFormat(chats) {
  const groupedChats = [];

  chats.forEach((chat) => {
    const number = chat.number;

    // Check if the group for this number already exists
    const existingGroup = groupedChats.find(
      (group) => group.instance === number,
    );

    if (existingGroup) {
      // Add chat to the existing group
      existingGroup.array.push(chat);
    } else {
      // Create a new group for this number
      groupedChats.push({
        instance: number,
        array: [chat],
      });
    }
  });

  return groupedChats;
}

// merge chat
router.post("/merge_chats", validateUser, async (req, res) => {
  try {
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

function convertNumberToRandomString(number) {
  const mapping = {
    0: "i",
    1: "j",
    2: "I",
    3: "u",
    4: "I",
    5: "U",
    6: "S",
    7: "D",
    8: "B",
    9: "j",
  };

  const numStr = number.toString();
  let result = "";
  for (let i = 0; i < numStr.length; i++) {
    const digit = numStr[i];
    result += mapping[digit];
  }
  return result;
}

router.post("/import_convo_from_v3", validateUser, async (req, res) => {
  try {
    const { newChatId, senderName, senderMobile, oldChatId } = req.body;

    if (!newChatId || !senderName || !senderMobile) {
      return res.json({ msg: "Invalid request" });
    }

    if (!oldChatId) {
      return res.json({
        msg: "This chat is from version 4. No converstaion found to be imported",
      });
    }

    const convoPath = `${__dirname}/../conversations/inbox/${req.decode.uid}/${oldChatId}.json`;
    const convoData = readJSONFile(convoPath);

    if (convoData?.length < 1) {
      return res.json({ msg: "No chat messages found to import" });
    }

    res.json({
      success: true,
      msg: "Conversation migrating has been started",
    });

    importConversationsFromJson({
      convos: convoData,
      newChatId,
      senderMobile,
      senderName,
      uid: req.decode.uid,
    });
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

router.get("/import_chats_from_v3", validateUser, async (req, res) => {
  try {
    const chatData = await query(`SELECT * FROM chats`, []);
    if (chatData?.length < 1) {
      return res.json({
        msg: "We could not find any chat list in older version, Please click Cancel icon to delete the [Import chats] button",
      });
    }
    res.json({
      msg: "Chats started importning... Please click Cancel icon to delete the [Import chats] button",
      success: true,
    });

    importChatsFromv3({ chatData });
  } catch (err) {
    console.log(err);
    res.json({ err, success: false, msg: "Something went wrong" });
  }
});

module.exports = router;
