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
const readLists = () => {
  try {
    return JSON.parse(fs.readFileSync(LIST_FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
};
const writeLists = (d) => fs.writeFileSync(LIST_FILE, JSON.stringify(d, null, 2));
const readGroups = () => {
  try {
    return JSON.parse(fs.readFileSync(GROUP_FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
};
const writeGroups = (d) => fs.writeFileSync(GROUP_FILE, JSON.stringify(d, null, 2));

// Check if user is admin
async function isAdmin(sock, chatId, userId) {
  try {
    const metadata = await sock.groupMetadata(chatId);
    const participant = metadata.participants.find(p => p.id === userId);
    return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
  } catch (error) {
    console.error("Error checking admin status:", error);
    return false;
  }
}

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
    .replace(/@time/gi, d.toLocaleTimeString("id-ID"))
    .replace(/@user/gi, `@${(msg.key.participant || msg.key.remoteJid).split('@')[0]}`);
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

      // Check if this is a reply to a message
      const isReply = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
      const repliedMsg = isReply ? msg.message.extendedTextMessage.contextInfo : null;
      
      // ---- ADDLIST (with reply) ----
      if (body.startsWith(".addlist") && isReply) {
        const input = body.replace(".addlist", "").trim();
        let [name] = input.split(" ");
        if (!name) {
          await sock.sendMessage(chatId, { text: "⚠️ Format: Balas sebuah pesan dengan `.addlist nama`" });
          continue;
        }
        name = name.trim().toLowerCase();

        if (!lists[chatId]) lists[chatId] = {};
        
        // Get the replied message content
        const repliedContent = repliedMsg.quotedMessage;
        
        // Handle media messages
        if (repliedContent.imageMessage || repliedContent.videoMessage) {
          try {
            const filename = `${chatId.replace(/[^a-zA-Z0-9]/g, '_')}_${name}_${Date.now()}`;
            const mediaData = await downloadMedia(repliedContent, filename);
            
            if (mediaData) {
              lists[chatId][name] = {
                type: mediaData.type,
                path: mediaData.path,
                mimetype: mediaData.mimetype,
                caption: input.replace(name, "").trim() || mediaData.caption
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
          const repliedText = repliedContent.conversation || 
                             repliedContent.extendedTextMessage?.text ||
                             "";
          lists[chatId][name] = { 
            type: "text", 
            text: input.replace(name, "").trim() || repliedText 
          };
          await sock.sendMessage(chatId, { text: `✅ List '${name}' ditambahkan.` }, { quoted: msg });
        }

        writeLists(lists);
        continue;
      }
      
      // ---- ADDLIST (without reply) ----
      else if (body.startsWith(".addlist")) {
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

      // ---- DELLIST ----
      if (body.startsWith(".dellist")) {
        const name = body.replace(".dellist", "").trim().toLowerCase();
        
        if (!name) {
          await sock.sendMessage(chatId, { text: "⚠️ Format: .dellist nama" });
          continue;
        }
        
        if (!lists[chatId] || !lists[chatId][name]) {
          await sock.sendMessage(chatId, { text: `❌ List '${name}' tidak ditemukan.` });
          continue;
        }
        
        // Delete media file if exists
        if (lists[chatId][name].path && fs.existsSync(lists[chatId][name].path)) {
          try {
            fs.unlinkSync(lists[chatId][name].path);
          } catch (error) {
            console.error("Error deleting media file:", error);
          }
        }
        
        // Remove from list
        delete lists[chatId][name];
        
        // Clean up empty chat entries
        if (Object.keys(lists[chatId]).length === 0) {
          delete lists[chatId];
        }
        
        writeLists(lists);
        await sock.sendMessage(chatId, { text: `🗑️ List '${name}' telah dihapus.` }, { quoted: msg });
        continue;
      }

      // ---- UPDATELIST (with reply) ----
      if (body.startsWith(".updatelist") && isReply) {
        const input = body.replace(".updatelist", "").trim();
        let [name] = input.split(" ");
        if (!name) {
          await sock.sendMessage(chatId, { text: "⚠️ Format: Balas sebuah pesan dengan `.updatelist nama`" });
          continue;
        }
        name = name.trim().toLowerCase();

        if (!lists[chatId] || !lists[chatId][name]) {
          await sock.sendMessage(chatId, { text: `❌ List '${name}' belum ada.` });
          continue;
        }

        // Get the replied message content
        const repliedContent = repliedMsg.quotedMessage;
        
        // Handle media updates
        if (repliedContent.imageMessage || repliedContent.videoMessage) {
          try {
            // Delete old media file if exists
            if (lists[chatId][name].path && fs.existsSync(lists[chatId][name].path)) {
              fs.unlinkSync(lists[chatId][name].path);
            }
            
            const filename = `${chatId.replace(/[^a-zA-Z0-9]/g, '_')}_${name}_${Date.now()}`;
            const mediaData = await downloadMedia(repliedContent, filename);
            
            if (mediaData) {
              lists[chatId][name] = {
                type: mediaData.type,
                path: mediaData.path,
                mimetype: mediaData.mimetype,
                caption: input.replace(name, "").trim() || mediaData.caption
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
          const repliedText = repliedContent.conversation || 
                             repliedContent.extendedTextMessage?.text ||
                             "";
          lists[chatId][name] = { 
            type: "text", 
            text: input.replace(name, "").trim() || repliedText 
          };
          await sock.sendMessage(chatId, { text: `♻️ List '${name}' diperbarui.` }, { quoted: msg });
        }

        writeLists(lists);
        continue;
      }
      
      // ---- UPDATELIST (without reply) ----
      else if (body.startsWith(".updatelist")) {
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

      // ---- OPEN GROUP ----
      if (body.startsWith(".open")) {
        if (!isGroup) {
          await sock.sendMessage(chatId, { text: "❌ Perintah ini hanya untuk grup." });
          continue;
        }
        
        // Check if user is admin
        if (!await isAdmin(sock, chatId, sender)) {
          await sock.sendMessage(chatId, { text: "❌ Hanya admin yang bisa membuka grup." });
          continue;
        }
        
        if (!groups[chatId]) groups[chatId] = { isOpen: true, welcome: "", bye: "" };
        groups[chatId].isOpen = true;
        writeGroups(groups);
        
        await sock.sendMessage(chatId, { text: "✅ Grup dibuka. Bot sekarang aktif di grup ini." });
        continue;
      }

      // ---- CLOSE GROUP ----
      if (body.startsWith(".close")) {
        if (!isGroup) {
          await sock.sendMessage(chatId, { text: "❌ Perintah ini hanya untuk grup." });
          continue;
        }
        
        // Check if user is admin
        if (!await isAdmin(sock, chatId, sender)) {
          await sock.sendMessage(chatId, { text: "❌ Hanya admin yang bisa menutup grup." });
          continue;
        }
        
        if (!groups[chatId]) groups[chatId] = { isOpen: false, welcome: "", bye: "" };
        groups[chatId].isOpen = false;
        writeGroups(groups);
        
        await sock.sendMessage(chatId, { text: "🔒 Grup ditutup. Bot tidak akan merespons di grup ini." });
        continue;
      }

      // ---- SETWELCOME ----
      if (body.startsWith(".setwelcome")) {
        if (!isGroup) {
          await sock.sendMessage(chatId, { text: "❌ Perintah ini hanya untuk grup." });
          continue;
        }
        
        // Check if user is admin
        if (!await isAdmin(sock, chatId, sender)) {
          await sock.sendMessage(chatId, { text: "❌ Hanya admin yang bisa mengatur welcome message." });
          continue;
        }
        
        const welcomeMsg = body.replace(".setwelcome", "").trim();
        if (!welcomeMsg) {
          await sock.sendMessage(chatId, { text: "⚠️ Format: .setwelcome pesan\nGunakan @user untuk mention anggota baru, @group untuk nama grup" });
          continue;
        }
        
        if (!groups[chatId]) groups[chatId] = { isOpen: true, welcome: welcomeMsg, bye: "" };
        groups[chatId].welcome = welcomeMsg;
        writeGroups(groups);
        
        await sock.sendMessage(chatId, { text: `✅ Welcome message disetel:\n${welcomeMsg}` });
        continue;
      }

      // ---- SETBYE ----
      if (body.startsWith(".setbye")) {
        if (!isGroup) {
          await sock.sendMessage(chatId, { text: "❌ Perintah ini hanya untuk grup." });
          continue;
        }
        
        // Check if user is admin
        if (!await isAdmin(sock, chatId, sender)) {
          await sock.sendMessage(chatId, { text: "❌ Hanya admin yang bisa mengatur bye message." });
          continue;
        }
        
        const byeMsg = body.replace(".setbye", "").trim();
        if (!byeMsg) {
          await sock.sendMessage(chatId, { text: "⚠️ Format: .setbye pesan\nGunakan @user untuk mention anggota yang keluar, @group untuk nama grup" });
          continue;
        }
        
        if (!groups[chatId]) groups[chatId] = { isOpen: true, welcome: "", bye: byeMsg };
        groups[chatId].bye = byeMsg;
        writeGroups(groups);
        
        await sock.sendMessage(chatId, { text: `✅ Bye message disetel:\n${byeMsg}` });
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
      // Check if group is open (only for groups)
      if (isGroup && groups[chatId] && !groups[chatId].isOpen) {
        continue; // Skip processing if group is closed
      }
      
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
    const groupConfig = groups[id] || { isOpen: true, welcome: "", bye: "" };

    // Skip if group is closed
    if (!groupConfig.isOpen) return;

    if (action === "add" && groupConfig.welcome) {
      for (const p of participants) {
        const text = groupConfig.welcome
          .replace(/@user/gi, `@${p.split("@")[0]}`)
          .replace(/@group/gi, (await sock.groupMetadata(id)).subject || "Grup ini");
        await sock.sendMessage(id, { text, mentions: [p] });
      }
    }
    if (action === "remove" && groupConfig.bye) {
      for (const p of participants) {
        const text = groupConfig.bye
          .replace(/@user/gi, `@${p.split("@")[0]}`)
          .replace(/@group/gi, (await sock.groupMetadata(id)).subject || "Grup ini");
        await sock.sendMessage(id, { text, mentions: [p] });
      }
    }
  });
}

startBot();