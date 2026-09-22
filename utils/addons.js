const { checkTelePlugin } = require("../helper/addon/telegram/tele.js");

function returnAddons() {
  const { checkQr } = require("../helper/addon/qr/index.js");
  const { checkWebhook } = require("../helper/addon/webhook/index.js");
  const { checkWaCall } = require("../helper/addon/wacall/wacall.js");
  const { checkEmbed } = require("../helper/addon/embed/index.js");
  const { addON } = require("../env.js");

  const qrCheck = checkQr();
  const wooCheck = checkWebhook();
  const waCallChceck = checkWaCall();
  const embedCheck = checkEmbed();
  const checkTele = checkTelePlugin();

  const finalAddon = [
    wooCheck && "WEBHOOK",
    addON?.includes("AI_BOT") && "AI_BOT",
    qrCheck && "QR",
    waCallChceck && "WACALL",
    embedCheck && "EMBED",
    checkTele && "TELEGRAM",
  ].filter(Boolean);

  return finalAddon;
}

module.exports = { returnAddons };
