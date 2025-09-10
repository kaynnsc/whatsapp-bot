// Import modules
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { writeFile } = require('fs/promises');

// Direktori & file
const SESSION_DIR = './sessions';
const CONFIG_DIR = './config';
const MEDIA_DIR = './media';
const LIST_FILE = path.join(CONFIG_DIR, 'lists.json');
const GROUP_FILE = path.join(CONFIG_DIR, 'groups.json');

// Pastikan folder ada
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(LIST_FILE)) fs.writeFileSync(LIST_FILE, JSON.stringify({}));
if (!fs.existsSync(GROUP_FILE)) fs.writeFileSync(GROUP_FILE, JSON.stringify({}));

// Helper read/write
const readLists = () => JSON.parse(fs.readFileSync(LIST_FILE, 'utf-8'));
const writeLists = (d) => fs.writeFileSync(LIST_FILE, JSON.stringify(d, null, 2));
const readGroups = () => JSON.parse(fs.readFileSync(GROUP_FILE, 'utf-8'));
const writeGroups = (d) => fs.writeFileSync(GROUP_FILE, JSON.stringify(d, null, 2));

// Download media function
async function downloadMedia(message, filename) {
    const mediaType = message.imageMessage ? 'image' : 
                     message.videoMessage ? 'video' : 
                     message.audioMessage ? 'audio' : 
                     message.documentMessage ? 'document' : null;
    
    if (!mediaType) return null;
    
    const media = message[`${mediaType}Message`];
    const stream = await downloadContentFromMessage(media, mediaType);
    let buffer = Buffer.from([]);
    
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    
    const ext = mediaType === 'image' ? (media.mimetype === 'image/jpeg' ? '.jpg' : '.png') : 
               mediaType === 'video' ? '.mp4' : 
               mediaType === 'audio' ? (media.mimetype === 'audio/ogg; codecs=opus' ? '.ogg' : '.mp3') : 
               mediaType === 'document' ? (media.fileName ? path.extname(media.fileName) : '.bin') : '.bin';
    
    const filePath = path.join(MEDIA_DIR, `${filename}${ext}`);
    await writeFile(filePath, buffer);
    
    return {
        type: mediaType,
        path: filePath,
        mimetype: media.mimetype,
        caption: media.caption || ''
    };
}

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
        
        // Handle media messages
        if (msg.message.imageMessage || msg.message.videoMessage) {
          try {
            const filename = `${chatId.replace(/[^a-zA-Z0-9]/g, '_')}_${name}_${Date.now()}`;
            const mediaData = await downloadMedia(msg.message, filename);
            
            if (mediaData) {
              lists[chatId][name] = {
                type: mediaData.type,
                path: mediaData.path,
                mimetype: mediaData.mimetype,
                caption: content || mediaData.caption
              };
              await sock.sendMessage(chatId, { text: `✅ List '${name}' dengan media ditambahkan.` }, { quoted: msg });
            } else {
              await sock.sendMessage(chatId, { text: "❌ Gagal memproses media." }, { quoted: msg });
            }
          } catch (error) {
            console.error("Error downloading media:", error);
            await sock.sendMessage(chatId, { text: "❌ Error memproses media." }, { quoted: msg });
          }
        } else {
          // Handle text messages
          lists[chatId][name] = { type: "text", text: content };
          await sock.sendMessage(chatId, { text: `✅ List '${name}' ditambahkan.` }, { quoted: msg });
        }

        writeLists(lists);
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

        // Handle media updates
        if (msg.message.imageMessage || msg.message.videoMessage) {
          try {
            // Delete old media file if exists
            if (lists[chatId][name].path && fs.existsSync(lists[chatId][name].path)) {
              fs.unlinkSync(lists[chatId][name].path);
            }
            
            const filename = `${chatId.replace(/[^a-zA-Z0-9]/g, '_')}_${name}_${Date.now()}`;
            const mediaData = await downloadMedia(msg.message, filename);
            
            if (mediaData) {
              lists[chatId][name] = {
                type: mediaData.type,
                path: mediaData.path,
                mimetype: mediaData.mimetype,
                caption: content || mediaData.caption
              };
              await sock.sendMessage(chatId, { text: `♻️ List '${name}' dengan media diperbarui.` }, { quoted: msg });
            } else {
              await sock.sendMessage(chatId, { text: "❌ Gagal memproses media." }, { quoted: msg });
            }
          } catch (error) {
            console.error("Error updating media:", error);
            await sock.sendMessage(chatId, { text: "❌ Error memproses media." }, { quoted: msg });
          }
        } else {
          // Handle text updates
          lists[chatId][name] = { type: "text", text: content };
          await sock.sendMessage(chatId, { text: `♻️ List '${name}' diperbarui.` }, { quoted: msg });
        }

        writeLists(lists);
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
          // Send media with caption
          const fileBuffer = fs.readFileSync(data.path);
          await sock.sendMessage(chatId, {
            [data.type]: fileBuffer,
            mimetype: data.mimetype,
            caption: replacePlaceholders(data.caption || '', msg, chatName)
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