const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  downloadMediaMessage
} = require("@whiskeysockets/baileys");
const express = require("express");
const fs = require("fs");

// ==== FILES ====
const COMMANDS_FILE = "commands.json";
const WELCOME_BYE_FILE = "welcome_bye.json";

// ==== LOAD DATA ====
let customCommands = {};
if (fs.existsSync(COMMANDS_FILE)) {
  try {
    customCommands = JSON.parse(fs.readFileSync(COMMANDS_FILE, "utf8"));
  } catch (e) {
    console.error("❌ Error load commands:", e);
  }
}
let welcomeByeMsg = { welcome: "", bye: "" };
if (fs.existsSync(WELCOME_BYE_FILE)) {
  try {
    welcomeByeMsg = JSON.parse(fs.readFileSync(WELCOME_BYE_FILE, "utf8"));
  } catch (e) {
    console.error("❌ Error load welcome/bye:", e);
  }
}

function saveCommands() {
  fs.writeFileSync(COMMANDS_FILE, JSON.stringify(customCommands, null, 2));
}
function saveWelcomeBye() {
  fs.writeFileSync(WELCOME_BYE_FILE, JSON.stringify(welcomeByeMsg, null, 2));
}

// ==== PLACEHOLDER ====
function replacePlaceholders(text, m, chatName) {
  if (!text) return text;
  let result = text;
  if (chatName) result = result.replace(/@group/gi, chatName);
  const d = new Date();
  result = result.replace(/@date/gi, d.toLocaleDateString("id-ID"));
  result = result.replace(/@time/gi, d.toLocaleTimeString("id-ID"));
  return result;
}

// ==== ADMIN CHECK ====
async function isGroupAdmin(sock, jid, sender) {
  try {
    const metadata = await sock.groupMetadata(jid);
    const participant = metadata.participants.find(
      (p) => jidNormalizedUser(p.id) === jidNormalizedUser(sender)
    );
    return participant?.admin !== null && participant?.admin !== undefined;
  } catch {
    return false;
  }
}

// ==== START BOT ====
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  // ==== MESSAGE HANDLER ====
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");

    let body = "";
    if (msg.message.conversation) body = msg.message.conversation;
    else if (msg.message.extendedTextMessage)
      body = msg.message.extendedTextMessage.text;
    else if (msg.message.imageMessage && msg.message.imageMessage.caption)
      body = msg.message.imageMessage.caption;

    body = body ? body.trim() : "";

    // ADDLIST
    if (body.startsWith(".addlist ")) {
      if (!(await isGroupAdmin(sock, from, sender)))
        return sock.sendMessage(from, { text: "❌ Only admin can use this." });

      const input = body.slice(9).split("||");
      const key = input[0].trim().toLowerCase();
      const value = input[1] ? input[1].trim() : "";

      if (msg.message.imageMessage || msg.message.videoMessage) {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        customCommands[key] = {
          text: value,
          media: {
            mimetype: msg.message.imageMessage
              ? msg.message.imageMessage.mimetype
              : msg.message.videoMessage.mimetype,
            data: buffer.toString("base64"),
            type: msg.message.imageMessage ? "image" : "video",
          },
        };
      } else {
        customCommands[key] = { text: value };
      }

      saveCommands();
      return sock.sendMessage(from, { text: `✅ List "${key}" added!` });
    }

    // UPDATELIST
    if (body.startsWith(".updatelist ")) {
      if (!(await isGroupAdmin(sock, from, sender)))
        return sock.sendMessage(from, { text: "❌ Only admin can use this." });

      const input = body.slice(12).split("||");
      const key = input[0].trim().toLowerCase();
      const value = input[1] ? input[1].trim() : "";

      if (!customCommands[key])
        return sock.sendMessage(from, { text: `❌ List "${key}" not found!` });

      if (msg.message.imageMessage || msg.message.videoMessage) {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        customCommands[key] = {
          text: value,
          media: {
            mimetype: msg.message.imageMessage
              ? msg.message.imageMessage.mimetype
              : msg.message.videoMessage.mimetype,
            data: buffer.toString("base64"),
            type: msg.message.imageMessage ? "image" : "video",
          },
        };
      } else {
        customCommands[key] = { text: value };
      }

      saveCommands();
      return sock.sendMessage(from, { text: `♻️ List "${key}" updated!` });
    }

    // LISTALL
    if (body === ".listall") {
      const keys = Object.keys(customCommands);
      if (keys.length === 0)
        return sock.sendMessage(from, { text: "📭 No list found." });
      return sock.sendMessage(from, {
        text: "📋 Available lists:\n" + keys.map((k) => `- ${k}`).join("\n"),
      });
    }

    // HIDETAG
    if (body.startsWith(".h")) {
      if (!(await isGroupAdmin(sock, from, sender)))
        return sock.sendMessage(from, { text: "❌ Only admin can use this." });

      const metadata = await sock.groupMetadata(from);
      const text = body.slice(2).trim();
      return sock.sendMessage(from, {
        text: text || "⚠️ Empty",
        mentions: metadata.participants.map((p) => p.id),
      });
    }

    // SHUTDOWN
    if (body === ".shutdown") {
      if (!(await isGroupAdmin(sock, from, sender)))
        return sock.sendMessage(from, { text: "❌ Only admin can shutdown." });

      await sock.sendMessage(from, { text: "🛑 Bot shutting down..." });
      process.exit(0);
    }

    // TRIGGER LIST
    const key = body.toLowerCase();
    if (customCommands[key]) {
      const cmd = customCommands[key];
      const text = replacePlaceholders(cmd.text, msg, isGroup ? from : null);

      if (cmd.media) {
        const buffer = Buffer.from(cmd.media.data, "base64");
        await sock.sendMessage(from, {
          [cmd.media.type]: buffer,
          mimetype: cmd.media.mimetype,
          caption: text,
        });
      } else {
        await sock.sendMessage(from, { text });
      }
    }
  });

  // ==== GROUP WELCOME / BYE ====
  sock.ev.on("group-participants.update", async (update) => {
    const metadata = await sock.groupMetadata(update.id);
    if (update.action === "add" && welcomeByeMsg.welcome) {
      for (let user of update.participants) {
        await sock.sendMessage(update.id, {
          text: replacePlaceholders(
            welcomeByeMsg.welcome.replace(/@user/gi, `@${user.split("@")[0]}`),
            {},
            metadata.subject
          ),
          mentions: [user],
        });
      }
    }
    if (update.action === "remove" && welcomeByeMsg.bye) {
      for (let user of update.participants) {
        await sock.sendMessage(update.id, {
          text: replacePlaceholders(
            welcomeByeMsg.bye.replace(/@user/gi, `@${user.split("@")[0]}`),
            {},
            metadata.subject
          ),
          mentions: [user],
        });
      }
    }
  });
}

// ==== EXPRESS SERVER ====
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot is running!"));
app.listen(port, () => console.log(`Server running at port ${port}`));

// RUN
startBot();