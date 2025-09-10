// index.js
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

// ====== KONFIG ======
const SESSION_DIR = './sessions';
const CONFIG_DIR = './config';
const LIST_FILE = path.join(CONFIG_DIR, 'lists.json');
const GROUP_CONFIG_FILE = path.join(CONFIG_DIR, 'groups.json');
const PORT = process.env.PORT || 3000;
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || 'https://fuzzy-cod-v6vrxr6pgp57cwprq.github.dev/';
const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 menit

// ====== PASTIKAN DIREKTORI & FILE ADA ======
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
if (!fs.existsSync(LIST_FILE)) fs.writeFileSync(LIST_FILE, JSON.stringify({}));
if (!fs.existsSync(GROUP_CONFIG_FILE)) fs.writeFileSync(GROUP_CONFIG_FILE, JSON.stringify({}));

// ====== HELPERS BACA/TULIS FILE ======
const readJSON = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { return {}; }
};
const writeJSON = (p, data) => {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
};

const readLists = () => readJSON(LIST_FILE);
const writeLists = (data) => writeJSON(LIST_FILE, data);
const readGroupConfig = () => readJSON(GROUP_CONFIG_FILE);
const writeGroupConfig = (data) => writeJSON(GROUP_CONFIG_FILE, data);

// ====== Express (untuk health / keep-alive endpoint opsional) ======
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Server running at port ${PORT}`));

// ====== START BOT ======
async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false // kita sendiri handle QR
    });

    // show QR
    sock.ev.on('connection.update', (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          console.log('Scan QR code berikut untuk login:');
          qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
          console.log('✅ Bot terhubung!');
        }
        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          console.log('🔴 Koneksi terputus:', lastDisconnect?.error?.message || lastDisconnect?.error, 'rekoneksi?', shouldReconnect);
          if (shouldReconnect) {
            setTimeout(() => startBot(), 2000);
          } else {
            console.log('❗ Session logged out. Hapus folder sessions dan scan ulang QR.');
          }
        }
      } catch (e) {
        console.error('connection.update error', e);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // ====== MESSAGE HANDLER ======
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        for (const message of messages) {
          try {
            if (!message.message || message.key && message.key.remoteJid === 'status@broadcast') continue;

            const chatId = message.key.remoteJid;
            const isGroup = chatId.endsWith('@g.us');
            const sender = message.key.participant || message.key.remoteJid;
            // Ambil teks pesan (bisa dari conversation atau extendedTextMessage)
            const getMessageText = (msg) => {
              if (!msg) return '';
              return msg.conversation ||
                (msg.extendedTextMessage && msg.extendedTextMessage.text) ||
                (msg.imageMessage && msg.imageMessage.caption) ||
                '';
            };
            const messageContent = getMessageText(message.message).trim();
            if (!messageContent) continue;

            // Hanya proses untuk grup (sesuaikan kalau mau private chat juga)
            // Note: kalau mau juga di private, hapus isGroup check
            if (!isGroup) continue;

            // Group metadata & admin check
            let groupMetadata;
            try {
              groupMetadata = await sock.groupMetadata(chatId);
            } catch (e) {
              groupMetadata = null;
            }
            const groupParticipants = groupMetadata?.participants || [];
            const groupAdmins = groupParticipants.filter(p => p.admin).map(p => p.id);
            const isAdmin = groupAdmins.includes(sender);

            // Persiapan config
            const groupConfigs = readGroupConfig();
            const gconf = groupConfigs[chatId] || { isOpen: true, welcome: '', bye: '' };

            // Jika pesan berupa perintah (diawali titik)
            if (messageContent.startsWith('.')) {
              const raw = messageContent.slice(1).trim();
              const [rawCommand, ...rawArgs] = raw.split(' ');
              const command = rawCommand.toLowerCase();
              const restArgs = rawArgs.join(' ').trim();

              // Helper: ambil isi pesan yang direply (jika ada)
              const getQuotedText = (msg) => {
                try {
                  const ctx = msg.message.extendedTextMessage?.contextInfo;
                  if (!ctx || !ctx.quotedMessage) return '';
                  return getMessageText(ctx.quotedMessage);
                } catch (e) { return ''; }
              };

              // Fungsi parsing keyword + content supporting both "||" and newline/reply
              const parseKeywordContent = (argsText, msg) => {
                let keyword = '', content = '';
                if (argsText.includes('||')) {
                  const parts = argsText.split('||').map(s => s.trim());
                  keyword = parts[0] || '';
                  content = parts.slice(1).join(' || ') || '';
                } else {
                  // asumsi: ".addlist keyword rest..." -> keyword = first token
                  const tokens = argsText.split(/\s+/);
                  keyword = tokens.shift() || '';
                  content = tokens.join(' ').trim();
                  if (!content) {
                    // kalau nggak ada content di baris yang sama, cek quoted message
                    const quoted = getQuotedText(msg);
                    if (quoted) content = quoted.trim();
                  }
                }
                return { keyword: keyword.toLowerCase(), content };
              };

              // ===== ADMIN COMMANDS =====
              if (isAdmin) {
                switch (command) {
                  case 'addlist': {
                    const { keyword, content } = parseKeywordContent(restArgs, message);
                    if (!keyword || !content) {
                      await sock.sendMessage(chatId, { text: '❌ Format salah!\nGunakan:\n.addlist [keyword] [isi]\natau\n.addlist [keyword] || [isi]\natau reply pesan dengan .addlist [keyword]' }, { quoted: message });
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
                    const { keyword, content } = parseKeywordContent(restArgs, message);
                    if (!keyword || !content) {
                      await sock.sendMessage(chatId, { text: '❌ Format salah!\nGunakan:\n.updatelist [keyword] [isi baru]\natau\n.updatelist [keyword] || [isi baru]\natau reply pesan dengan .updatelist [keyword]' }, { quoted: message });
                      break;
                    }
                    const lists = readLists();
                    if (!lists[chatId] || !lists[chatId][keyword]) {
                      await sock.sendMessage(chatId, { text: `❌ List "${keyword}" tidak ditemukan.` }, { quoted: message });
                      break;
                    }
                    lists[chatId][keyword] = content;
                    writeLists(lists);
                    await sock.sendMessage(chatId, { text: `✅ List "${keyword}" berhasil diupdate.` }, { quoted: message });
                    break;
                  }

                  case 'dellist': {
                    const keywordRaw = restArgs.split(/\s+/)[0] || '';
                    const keyword = keywordRaw.toLowerCase();
                    if (!keyword) {
                      await sock.sendMessage(chatId, { text: '❌ Gunakan: .dellist [keyword]' }, { quoted: message });
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

                  case 'list':
                  case 'listall': {
                    const lists = readLists();
                    if (!lists[chatId] || Object.keys(lists[chatId]).length === 0) {
                      await sock.sendMessage(chatId, { text: '📂 Belum ada list tersimpan.' }, { quoted: message });
                      break;
                    }
                    let text = '📂 Daftar List:\n\n';
                    for (const [k, v] of Object.entries(lists[chatId])) {
                      text += `• *${k}*\n${v}\n\n`;
                    }
                    await sock.sendMessage(chatId, { text }, { quoted: message });
                    break;
                  }

                  case 'hidetag':
                  case 'h': {
                    // Ambil teks dari argumen atau quoted message jika tidak ada argumen
                    let mentionText = restArgs || '';
                    if (!mentionText) {
                      // ambil quoted message content
                      const ctx = message.message.extendedTextMessage?.contextInfo;
                      if (ctx && ctx.quotedMessage) {
                        mentionText = getMessageText(ctx.quotedMessage) || '';
                      }
                    }
                    if (!mentionText) {
                      await sock.sendMessage(chatId, { text: '❌ Format salah!\nGunakan: .h [pesan] atau reply pesan dengan .h' }, { quoted: message });
                      break;
                    }
                    const mentionJids = groupParticipants.map(p => p.id);
                    await sock.sendMessage(chatId, { text: mentionText, mentions: mentionJids });
                    break;
                  }

                  case 'setwelcome': {
                    const welcomeMsg = restArgs || getQuotedText(message) || '';
                    if (!welcomeMsg) {
                      await sock.sendMessage(chatId, { text: '❌ Gunakan: .setwelcome [pesan]' }, { quoted: message });
                      break;
                    }
                    const g = readGroupConfig();
                    g[chatId] = g[chatId] || { isOpen: true, welcome: '', bye: '' };
                    g[chatId].welcome = welcomeMsg;
                    writeGroupConfig(g);
                    await sock.sendMessage(chatId, { text: '✅ Pesan welcome berhasil disimpan.' }, { quoted: message });
                    break;
                  }

                  case 'setbye': {
                    const byeMsg = restArgs || getQuotedText(message) || '';
                    if (!byeMsg) {
                      await sock.sendMessage(chatId, { text: '❌ Gunakan: .setbye [pesan]' }, { quoted: message });
                      break;
                    }
                    const g = readGroupConfig();
                    g[chatId] = g[chatId] || { isOpen: true, welcome: '', bye: '' };
                    g[chatId].bye = byeMsg;
                    writeGroupConfig(g);
                    await sock.sendMessage(chatId, { text: '✅ Pesan bye berhasil disimpan.' }, { quoted: message });
                    break;
                  }

                  case 'tutup': {
                    const g = readGroupConfig();
                    g[chatId] = g[chatId] || { isOpen: true, welcome: '', bye: '' };
                    g[chatId].isOpen = false;
                    writeGroupConfig(g);
                    await sock.sendMessage(chatId, { text: '🔒 Grup telah ditutup oleh admin.' }, { quoted: message });
                    break;
                  }

                  case 'buka': {
                    const g = readGroupConfig();
                    g[chatId] = g[chatId] || { isOpen: true, welcome: '', bye: '' };
                    g[chatId].isOpen = true;
                    writeGroupConfig(g);
                    await sock.sendMessage(chatId, { text: '🔓 Grup telah dibuka oleh admin.' }, { quoted: message });
                    break;
                  }

                  // tambahkan perintah admin lain sesuai kebutuhan
                  default: break;
                } // end switch admin
              } else {
                // Non-admin trying admin-only commands
                if (['addlist','updatelist','dellist','hidetag','h','tutup','buka','setwelcome','setbye'].includes(command)) {
                  await sock.sendMessage(chatId, { text: '❌ Maaf, perintah ini hanya untuk admin.' }, { quoted: message });
                }
              }
            } // end if startsWith('.')

            // ===== TRIGGER LIST (case-insensitive) =====
            try {
              const lists = readLists();
              const lookup = messageContent.toLowerCase();
              if (lists[chatId] && lists[chatId][lookup]) {
                await sock.sendMessage(chatId, { text: lists[chatId][lookup] }, { quoted: message });
              }
            } catch (e) {
              // ignore
            }

            // End processing message
          } catch (e) {
            console.error('Error processing a message:', e);
          }
        } // end for messages
      } catch (e) {
        console.error('messages.upsert handler error:', e);
      }
    }); // end messages.upsert

    // ===== group participants update (welcome/bye) =====
    sock.ev.on('group-participants.update', async (update) => {
      try {
        const { id, participants, action } = update;
        const gcfg = readGroupConfig()[id] || { isOpen: true, welcome: '', bye: '' };

        if (action === 'add' && gcfg.welcome) {
          for (const p of participants) {
            const welcomeText = gcfg.welcome.replace('@user', `@${p.split('@')[0]}`);
            await sock.sendMessage(id, { text: welcomeText, mentions: [p] });
          }
        }

        if (action === 'remove' && gcfg.bye) {
          for (const p of participants) {
            const byeText = gcfg.bye.replace('@user', `@${p.split('@')[0]}`);
            await sock.sendMessage(id, { text: byeText, mentions: [p] });
          }
        }
      } catch (e) {
        console.error('group-participants.update error', e);
      }
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('Shutting down...');
      try { await sock.logout(); } catch {}
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('Shutting down...');
      try { await sock.logout(); } catch {}
      process.exit(0);
    });

    // Keep-alive ping (prevent Codespaces sleep)
    setInterval(async () => {
      try {
        const { default: fetch } = await import('node-fetch');
        const res = await fetch(KEEP_ALIVE_URL);
        console.log(`[keep-alive] ${KEEP_ALIVE_URL} -> ${res.status}`);
      } catch (e) {
        console.error('[keep-alive] error', e.message || e);
      }
    }, KEEP_ALIVE_INTERVAL_MS);

  } catch (e) {
    console.error('startBot error', e);
    setTimeout(() => startBot(), 3000);
  }
}

// Start
startBot();