const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

// Konfigurasi dasar
const SESSION_DIR = './sessions';
const CONFIG_DIR = './config';
const LIST_FILE = path.join(CONFIG_DIR, 'lists.json');
const GROUP_CONFIG_FILE = path.join(CONFIG_DIR, 'groups.json');

// Pastikan direktori ada
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
if (!fs.existsSync(LIST_FILE)) fs.writeFileSync(LIST_FILE, JSON.stringify({}));
if (!fs.existsSync(GROUP_CONFIG_FILE)) fs.writeFileSync(GROUP_CONFIG_FILE, JSON.stringify({}));

// Fungsi untuk baca/tulis konfigurasi
const readLists = () => JSON.parse(fs.readFileSync(LIST_FILE, 'utf-8'));
const writeLists = (data) => fs.writeFileSync(LIST_FILE, JSON.stringify(data, null, 2));
const readGroupConfig = () => JSON.parse(fs.readFileSync(GROUP_CONFIG_FILE, 'utf-8'));
const writeGroupConfig = (data) => fs.writeFileSync(GROUP_CONFIG_FILE, JSON.stringify(data, null, 2));

// Start bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan QR code berikut untuk login:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus:', lastDisconnect?.error, 'Mencoba reconnect:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot terhubung!');
    }
  });

  // Handler pesan
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      if (message.key.remoteJid === 'status@broadcast' || !message.message) continue;

      const chatId = message.key.remoteJid;
      const isGroup = chatId.endsWith('@g.us');
      const sender = message.key.participant || message.key.remoteJid;
      const messageContent = message.message.conversation ||
        (message.message.extendedTextMessage && message.message.extendedTextMessage.text) || '';

      if (!isGroup) continue;

      const groupMetadata = await sock.groupMetadata(chatId);
      const groupAdmins = groupMetadata.participants.filter(p => p.admin).map(p => p.id);
      const isAdmin = groupAdmins.includes(sender);

      const groupConfigs = readGroupConfig();
      const groupConfig = groupConfigs[chatId] || { isOpen: true, welcome: '', bye: '' };

      if (messageContent.startsWith('.')) {
        const [rawCommand, ...rawArgs] = messageContent.slice(1).trim().split(' ');
        const command = rawCommand.toLowerCase();
        let args = rawArgs;

        if (isAdmin) {
          switch (command) {
            case 'addlist': {
              let keyword, content;
              const joined = rawArgs.join(' ');
              if (joined.includes('||')) {
                [keyword, content] = joined.split('||').map(s => s.trim());
              } else {
                keyword = rawArgs[0];
                content = rawArgs.slice(1).join(' ');
              }

              if (!keyword || !content) {
                await sock.sendMessage(chatId, { text: '❌ Format salah!\nGunakan: .addlist [keyword] [isi] atau .addlist [keyword] || [isi]' }, { quoted: message });
                break;
              }

              const lists = readLists();
              if (!lists[chatId]) lists[chatId] = {};
              lists[chatId][keyword] = content;
              writeLists(lists);

              await sock.sendMessage(chatId, { text: `✅ List "${keyword}" berhasil ditambahkan.` }, { quoted: message });
              break;
            }

            case 'updatelist': {
              let keyword, content;
              const joined = rawArgs.join(' ');
              if (joined.includes('||')) {
                [keyword, content] = joined.split('||').map(s => s.trim());
              } else {
                keyword = rawArgs[0];
                content = rawArgs.slice(1).join(' ');
              }

              if (!keyword || !content) {
                await sock.sendMessage(chatId, { text: '❌ Format salah!\nGunakan: .updatelist [keyword] [isi baru] atau .updatelist [keyword] || [isi baru]' }, { quoted: message });
                break;
              }

              const lists = readLists();
              if (!lists[chatId] || !lists[chatId][keyword]) {
                await sock.sendMessage(chatId, { text: `❌ List "${keyword}" tidak ditemukan.` }, { quoted: message });
                break;
              }

              lists[chatId][keyword] = content;
              writeLists(lists);

              await sock.sendMessage(chatId, { text: `✅ List "${keyword}" berhasil diperbarui.` }, { quoted: message });
              break;
            }

            case 'dellist': {
              const keyword = rawArgs[0];
              if (!keyword) {
                await sock.sendMessage(chatId, { text: '❌ Format salah! Gunakan: .dellist [keyword]' }, { quoted: message });
                break;
              }

              const lists = readLists();
              if (!lists[chatId] || !lists[chatId][keyword]) {
                await sock.sendMessage(chatId, { text: `❌ List "${keyword}" tidak ditemukan.` }, { quoted: message });
                break;
              }

              delete lists[chatId][keyword];
              writeLists(lists);

              await sock.sendMessage(chatId, { text: `✅ List "${keyword}" berhasil dihapus.` }, { quoted: message });
              break;
            }

            case 'hidetag':
            case 'h': {
              const mentionText = args.join(' ') || 'Attention everyone!';
              const mentionJids = groupMetadata.participants.map(p => p.id);

              await sock.sendMessage(chatId, {
                text: mentionText,
                mentions: mentionJids
              });
              break;
            }
          }
        } else if (['addlist', 'updatelist', 'dellist', 'hidetag', 'h'].includes(command)) {
          await sock.sendMessage(chatId, { text: '❌ Maaf, perintah ini hanya untuk admin.' }, { quoted: message });
        }
      }

      // Trigger list reply
      const lists = readLists();
      if (lists[chatId] && lists[chatId][messageContent]) {
        await sock.sendMessage(chatId, { text: lists[chatId][messageContent] }, { quoted: message });
      }
    }
  });
}

startBot();