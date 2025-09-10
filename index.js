// Import modules
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

// Direktori & file
const SESSION_DIR = './sessions';
const CONFIG_DIR = './config';
const LIST_FILE = path.join(CONFIG_DIR, 'lists.json');
const GROUP_FILE = path.join(CONFIG_DIR, 'groups.json');

// Pastikan folder ada
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
if (!fs.existsSync(LIST_FILE)) fs.writeFileSync(LIST_FILE, JSON.stringify({}));
if (!fs.existsSync(GROUP_FILE)) fs.writeFileSync(GROUP_FILE, JSON.stringify({}));

// Helper read/write
const readLists = () => JSON.parse(fs.readFileSync(LIST_FILE, 'utf-8'));
const writeLists = (d) => fs.writeFileSync(LIST_FILE, JSON.stringify(d, null, 2));
const readGroups = () => JSON.parse(fs.readFileSync(GROUP_FILE, 'utf-8'));
const writeGroups = (d) => fs.writeFileSync(GROUP_FILE, JSON.stringify(d, null, 2));

// Replace placeholder
function replacePlaceholders(text, msg, chatName) {
  if (!text) return text;
  const d = new Date();
  return text
    .replace(/@group/gi, chatName || "Grup ini")
    .replace(/@date/gi, d.toLocaleDateString("id-ID"))
    .replace(/@time/gi, d.toLocaleTimeString("id-ID"));
}

// Start bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const sock = makeWASocket({ auth: state, logger: pino({ level: "silent" }) });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      console.log("Scan QR berikut untuk login:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") console.log("✅ Bot terhubung!");
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) startBot();
      else console.log("❌ Logged out.");
    }
  });

  // Message handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.remoteJid === "status@broadcast") continue;
      const chatId = msg.key.remoteJid;
      const isGroup = chatId.endsWith("@g.us");
      const sender = msg.key.participant || msg.key.remoteJid;
      const chatName = isGroup ? (await sock.groupMetadata(chatId)).subject : "Chat ini";

      let body =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      body = body.trim();
      const lists = readLists();
      const groups = readGroups();
      const groupConfig = groups[chatId] || { isOpen: true, welcome: "", bye: "" };

      // ---- ADDLIST ----
      if (body.startsWith(".addlist")) {
        const input = body.replace(".addlist", "").trim();
        let [name, ...contentArr] = input.split("||");
        if (!name) {
          await sock.sendMessage(chatId, { text: "⚠️ Format: .addlist nama || isi" });
          continue;
        }
        name = name.trim().toLowerCase();
        const content = contentArr.join("||").trim();

        if (!lists[chatId]) lists[chatId] = {};
        if (msg.message.imageMessage || msg.message.videoMessage) {
          const type = msg.message.imageMessage ? "image" : "video";
          const media = msg.message[`${type}Message`];
          lists[chatId][name] = { type, media, caption: content };
        } else {
          lists[chatId][name] = { type: "text", text: content };
        }

        writeLists(lists);
        await sock.sendMessage(chatId, { text: `✅ List '${name}' ditambahkan.` }, { quoted: msg });
        continue;
      }

      // ---- UPDATELIST ----
      if (body.startsWith(".updatelist")) {
        const input = body.replace(".updatelist", "").trim();
        let [name, ...contentArr] = input.split("||");
        if (!name) {
          await sock.sendMessage(chatId, { text: "⚠️ Format: .updatelist nama || isi" });
          continue;
        }
        name = name.trim().toLowerCase();
        const content = contentArr.join("||").trim();

        if (!lists[chatId] || !lists[chatId][name]) {
          await sock.sendMessage(chatId, { text: `❌ List '${name}' belum ada.` });
          continue;
        }

        if (msg.message.imageMessage || msg.message.videoMessage) {
          const type = msg.message.imageMessage ? "image" : "video";
          const media = msg.message[`${type}Message`];
          lists[chatId][name] = { type, media, caption: content };
        } else {
          lists[chatId][name] = { type: "text", text: content };
        }

        writeLists(lists);
        await sock.sendMessage(chatId, { text: `♻️ List '${name}' diperbarui.` }, { quoted: msg });
        continue;
      }

      // ---- HIDETAG ----
      if (body.startsWith(".h")) {
        const text = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
          body.replace(".h", "").trim();

        if (!isGroup) {
          await sock.sendMessage(chatId, { text });
          continue;
        }
        const metadata = await sock.groupMetadata(chatId);
        const mentions = metadata.participants.map(p => p.id);
        await sock.sendMessage(chatId, { text, mentions });
        continue;
      }

      // ---- SHUTDOWN ----
      if (body === ".shutdown") {
        const metadata = await sock.groupMetadata(chatId);
        const admins = metadata.participants.filter(p => p.admin).map(p => p.id);
        if (admins.includes(sender)) {
          await sock.sendMessage(chatId, { text: "🛑 Bot dimatikan oleh admin." });
          process.exit(0);
        } else {
          await sock.sendMessage(chatId, { text: "❌ Hanya admin yang bisa shutdown." });
        }
        continue;
      }

      // ---- TRIGGER LIST ----
      const key = body.toLowerCase();
      if (lists[chatId] && lists[chatId][key]) {
        const data = lists[chatId][key];
        if (data.type === "text") {
          const text = replacePlaceholders(data.text, msg, chatName);
          await sock.sendMessage(chatId, { text }, { quoted: msg });
        } else {
          await sock.sendMessage(chatId, {
            [data.type]: data.media,
            caption: replacePlaceholders(data.caption, msg, chatName)
          }, { quoted: msg });
        }
      }
    }
  });

  // Grup event (welcome/bye)
  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    const groups = readGroups();
    const groupConfig = groups[id] || { welcome: "", bye: "" };

    if (action === "add" && groupConfig.welcome) {
      for (const p of participants) {
        const text = groupConfig.welcome.replace("@user", `@${p.split("@")[0]}`);
        await sock.sendMessage(id, { text, mentions: [p] });
      }
    }
    if (action === "remove" && groupConfig.bye) {
      for (const p of participants) {
        const text = groupConfig.bye.replace("@user", `@${p.split("@")[0]}`);
        await sock.sendMessage(id, { text, mentions: [p] });
      }
    }
  });
}

startBot();