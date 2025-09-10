const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");

// === Load lists.json ===
const LISTS_FILE = "lists.json";
let lists = {};
if (fs.existsSync(LISTS_FILE)) {
  lists = JSON.parse(fs.readFileSync(LISTS_FILE));
}
function writeLists() {
  fs.writeFileSync(LISTS_FILE, JSON.stringify(lists, null, 2));
}

// === Placeholder handler ===
function replacePlaceholders(text, groupMetadata, message) {
  const now = new Date();
  return text
    .replace(/@group/gi, groupMetadata?.subject || "")
    .replace(/@date/gi, now.toLocaleDateString("id-ID"))
    .replace(/@time/gi, now.toLocaleTimeString("id-ID"));
}

// === Save media from message ===
async function saveMediaMessage(sock, msg, name) {
  const type = Object.keys(msg.message)[0];
  const buffer = await downloadMediaMessage(msg, "buffer", {}, {});

  let ext = "";
  if (type.includes("image")) ext = "jpg";
  else if (type.includes("video")) ext = "mp4";
  else if (type.includes("audio")) ext = "mp3";
  else if (type.includes("document")) ext = "pdf";
  else ext = "bin";

  if (!fs.existsSync("media")) fs.mkdirSync("media");
  const filePath = path.join("media", `${name}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// === Main Bot ===
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("connection closed. reconnect:", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ Bot is running!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const body =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    const lowerBody = body.trim().toLowerCase();

    // === Commands ===
    if (lowerBody.startsWith(".addlist")) {
      const [_, rest] = body.split(" ", 2);
      const parts = body.replace(".addlist", "").trim().split("||");
      const listName = parts[0]?.trim().toLowerCase();
      const listText = parts[1]?.trim() || "";

      let mediaPath = null;
      const msgType = Object.keys(msg.message)[0];
      if (
        ["imageMessage", "videoMessage", "audioMessage", "documentMessage"].includes(
          msgType
        )
      ) {
        mediaPath = await saveMediaMessage(sock, msg, listName);
      }

      if (!lists[from]) lists[from] = {};
      lists[from][listName] = { text: listText, media: mediaPath };
      writeLists();

      await sock.sendMessage(from, {
        text: `✅ List "${listName}" berhasil ditambahkan!`
      });
    }

    else if (lowerBody.startsWith(".updatelist")) {
      const parts = body.replace(".updatelist", "").trim().split("||");
      const listName = parts[0]?.trim().toLowerCase();
      const listText = parts[1]?.trim() || "";

      if (!lists[from] || !lists[from][listName]) {
        await sock.sendMessage(from, { text: `❌ List "${listName}" tidak ada.` });
        return;
      }

      let mediaPath = lists[from][listName].media;
      const msgType = Object.keys(msg.message)[0];
      if (
        ["imageMessage", "videoMessage", "audioMessage", "documentMessage"].includes(
          msgType
        )
      ) {
        mediaPath = await saveMediaMessage(sock, msg, listName);
      }

      lists[from][listName] = { text: listText, media: mediaPath };
      writeLists();

      await sock.sendMessage(from, {
        text: `✅ List "${listName}" berhasil diperbarui!`
      });
    }

    // === Trigger list ===
    else if (lists[from] && lists[from][lowerBody]) {
      const { text, media } = lists[from][lowerBody];
      const groupMetadata = from.endsWith("@g.us")
        ? await sock.groupMetadata(from)
        : null;
      const replyText = replacePlaceholders(text, groupMetadata, msg);

      if (media) {
        let sendObj = {};
        if (media.endsWith(".jpg")) sendObj.image = { url: media };
        else if (media.endsWith(".mp4")) sendObj.video = { url: media };
        else if (media.endsWith(".mp3")) sendObj.audio = { url: media };
        else sendObj.document = { url: media };

        sendObj.caption = replyText || undefined;
        await sock.sendMessage(from, sendObj);
      } else {
        await sock.sendMessage(from, { text: replyText });
      }
    }

    // === Hidetag ===
    else if (lowerBody.startsWith(".h")) {
      let text =
        body.replace(".h", "").trim() ||
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
          ?.conversation;

      if (!text) return;

      const groupMetadata = from.endsWith("@g.us")
        ? await sock.groupMetadata(from)
        : null;
      const participants = groupMetadata?.participants?.map((p) => p.id) || [];

      await sock.sendMessage(from, {
        text,
        mentions: participants
      });
    }
  });
}

startBot();