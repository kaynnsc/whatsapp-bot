const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");

// Simpan daftar custom command
const COMMANDS_FILE = "commands.json";
let customCommands = {};
if (fs.existsSync(COMMANDS_FILE)) {
  try {
    customCommands = JSON.parse(fs.readFileSync(COMMANDS_FILE));
  } catch (e) {
    console.error("❌ Gagal membaca commands.json:", e);
  }
}

// Inisialisasi client
const client = new Client({
  authStrategy: new LocalAuth(),
});

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("✅ Bot is running!");
});

// Fungsi untuk simpan command
function saveCommands() {
  fs.writeFileSync(COMMANDS_FILE, JSON.stringify(customCommands, null, 2));
}

// Replace placeholder
function replacePlaceholders(text, msg) {
  const date = new Date();
  return text
    .replace(/@group/gi, msg.from.endsWith("@g.us") ? msg._data.notifyName || "Grup ini" : "Chat ini")
    .replace(/@date/gi, date.toLocaleDateString("id-ID"))
    .replace(/@time/gi, date.toLocaleTimeString("id-ID"));
}

client.on("message", async (msg) => {
  const chat = await msg.getChat();
  const isGroup = chat.isGroup;
  const isAdmin = isGroup && chat.participants.find(p => p.id._serialized === msg.author)?.isAdmin;

  const body = msg.body.trim();

  // ---- ADDLIST ----
  if (body.startsWith(".addlist")) {
    const input = body.replace(".addlist", "").trim();
    let [name, ...contentArr] = input.split("||");
    if (!name) {
      msg.reply("⚠️ Format salah.\nGunakan:\n.addlist nama || isi\nAtau reply media dengan .addlist nama");
      return;
    }
    name = name.trim().toLowerCase();
    let content = contentArr.join("||").trim();

    if (msg.hasMedia && !content) {
      const media = await msg.downloadMedia();
      customCommands[name] = { type: "media", media };
    } else {
      customCommands[name] = { type: "text", text: content };
    }

    saveCommands();
    msg.reply(`✅ List '${name}' berhasil ditambahkan.`);
    return;
  }

  // ---- UPDATELIST ----
  if (body.startsWith(".updatelist")) {
    const input = body.replace(".updatelist", "").trim();
    let [name, ...contentArr] = input.split("||");
    if (!name) {
      msg.reply("⚠️ Format salah.\nGunakan:\n.updatelist nama || isi\nAtau reply media dengan .updatelist nama");
      return;
    }
    name = name.trim().toLowerCase();
    let content = contentArr.join("||").trim();

    if (!customCommands[name]) {
      msg.reply(`❌ List '${name}' belum ada. Gunakan .addlist untuk membuat baru.`);
      return;
    }

    if (msg.hasMedia && !content) {
      const media = await msg.downloadMedia();
      customCommands[name] = { type: "media", media };
    } else {
      customCommands[name] = { type: "text", text: content };
    }

    saveCommands();
    msg.reply(`✅ List '${name}' berhasil diperbarui.`);
    return;
  }

  // ---- HIDETAG (.h) ----
  if (body.startsWith(".h")) {
    let text = body.replace(".h", "").trim();

    if (msg.hasQuotedMsg) {
      const quoted = await msg.getQuotedMessage();
      text = quoted.body || text;
    }

    text = replacePlaceholders(text, msg);

    if (isGroup) {
      const mentions = chat.participants.map((p) => p.id._serialized);
      chat.sendMessage(text, { mentions });
    } else {
      msg.reply(text);
    }
    return;
  }

  // ---- SHUTDOWN ----
  if (body === ".shutdown") {
    if (isAdmin) {
      msg.reply("⚠️ Bot dimatikan oleh admin grup.");
      setTimeout(() => process.exit(0), 1000);
    } else {
      msg.reply("❌ Hanya admin yang bisa mematikan bot.");
    }
    return;
  }

  // ---- TRIGGER LIST ----
  const cmd = body.toLowerCase();
  if (customCommands[cmd]) {
    const data = customCommands[cmd];
    if (data.type === "text") {
      const text = replacePlaceholders(data.text, msg);
      msg.reply(text);
    } else if (data.type === "media") {
      const media = new MessageMedia(data.media.mimetype, data.media.data, data.media.filename);
      client.sendMessage(msg.from, media, { caption: replacePlaceholders(data.media.caption || "", msg) });
    }
  }
});

client.initialize();