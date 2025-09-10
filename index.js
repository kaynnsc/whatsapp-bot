const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Konfigurasi dasar
const SESSION_DIR = './sessions';
const CONFIG_DIR = './config';
const LIST_FILE = path.join(CONFIG_DIR, 'lists.json');
const GROUP_CONFIG_FILE = path.join(CONFIG_DIR, 'groups.json');

// Pastikan direktori ada
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

// Inisialisasi file konfigurasi jika belum ada
if (!fs.existsSync(LIST_FILE)) fs.writeFileSync(LIST_FILE, JSON.stringify({}));
if (!fs.existsSync(GROUP_CONFIG_FILE)) fs.writeFileSync(GROUP_CONFIG_FILE, JSON.stringify({}));

// Fungsi untuk membaca dan menulis konfigurasi
const readLists = () => JSON.parse(fs.readFileSync(LIST_FILE, 'utf-8'));
const writeLists = (data) => fs.writeFileSync(LIST_FILE, JSON.stringify(data, null, 2));
const readGroupConfig = () => JSON.parse(fs.readFileSync(GROUP_CONFIG_FILE, 'utf-8'));
const writeGroupConfig = (data) => fs.writeFileSync(GROUP_CONFIG_FILE, JSON.stringify(data, null, 2));

// Membuat WhatsApp client
async function startBot() {
  // Autentikasi
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  
  // Inisialisasi socket
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });
  
  // Event handler untuk credentials
  sock.ev.on('creds.update', saveCreds);
  
  // Event handler untuk koneksi
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus:', lastDisconnect.error, 'Mencoba menghubungkan kembali:', shouldReconnect);
      
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('Bot terhubung!');
    }
  });
  
  // Event handler untuk pesan
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      if (message.key.remoteJid === 'status@broadcast' || !message.message) continue;
      
      const chatId = message.key.remoteJid;
      const isGroup = chatId.endsWith('@g.us');
      const sender = message.key.participant || message.key.remoteJid;
      const messageContent = message.message.conversation || 
                             (message.message.extendedTextMessage && message.message.extendedTextMessage.text) || 
                             '';
      
      // Hanya proses pesan di grup
      if (!isGroup) continue;
      
      // Mendapatkan info grup
      const groupMetadata = await sock.groupMetadata(chatId);
      const groupAdmins = groupMetadata.participants
        .filter(p => p.admin)
        .map(p => p.id);
      const isAdmin = groupAdmins.includes(sender);
      
      // Cek apakah grup terbuka atau tertutup
      const groupConfigs = readGroupConfig();
      const groupConfig = groupConfigs[chatId] || { isOpen: true, welcome: '', bye: '' };
      
      // Handler untuk perintah admin
      if (messageContent.startsWith('.')) {
        const [command, ...args] = messageContent.slice(1).trim().split(' ');
        
        // Perintah khusus admin
        if (isAdmin) {
          switch (command.toLowerCase()) {
            case 'tutup':
              groupConfig.isOpen = false;
              groupConfigs[chatId] = groupConfig;
              writeGroupConfig(groupConfigs);
              await sock.sendMessage(chatId, { text: '🔒 Grup telah ditutup oleh admin.' });
              break;
              
            case 'buka':
              groupConfig.isOpen = true;
              groupConfigs[chatId] = groupConfig;
              writeGroupConfig(groupConfigs);
              await sock.sendMessage(chatId, { text: '🔓 Grup telah dibuka oleh admin.' });
              break;
              
            case 'setwelcome':
              const welcomeMsg = args.join(' ');
              groupConfig.welcome = welcomeMsg;
              groupConfigs[chatId] = groupConfig;
              writeGroupConfig(groupConfigs);
              await sock.sendMessage(chatId, { text: `✅ Pesan welcome telah diatur:\n${welcomeMsg}` });
              break;
              
            case 'setbye':
              const byeMsg = args.join(' ');
              groupConfig.bye = byeMsg;
              groupConfigs[chatId] = groupConfig;
              writeGroupConfig(groupConfigs);
              await sock.sendMessage(chatId, { text: `✅ Pesan bye telah diatur:\n${byeMsg}` });
              break;
              
            case 'addlist':
              if (args.length < 2) {
                await sock.sendMessage(chatId, { text: '❌ Format salah! Gunakan: .addlist [keyword] [isi list]' });
                break;
              }
              
              const keyword = args[0];
              const content = args.slice(1).join(' ');
              
              const lists = readLists();
              if (!lists[chatId]) lists[chatId] = {};
              
              lists[chatId][keyword] = content;
              writeLists(lists);
              
              await sock.sendMessage(chatId, { text: `✅ List "${keyword}" telah ditambahkan.` });
              break;
              
            case 'updatelist':
              if (args.length < 2) {
                await sock.sendMessage(chatId, { text: '❌ Format salah! Gunakan: .updatelist [keyword] [isi list baru]' });
                break;
              }
              
              const updateKeyword = args[0];
              const updateContent = args.slice(1).join(' ');
              
              const updateLists = readLists();
              if (!updateLists[chatId] || !updateLists[chatId][updateKeyword]) {
                await sock.sendMessage(chatId, { text: `❌ List "${updateKeyword}" tidak ditemukan.` });
                break;
              }
              
              updateLists[chatId][updateKeyword] = updateContent;
              writeLists(updateLists);
              
              await sock.sendMessage(chatId, { text: `✅ List "${updateKeyword}" telah diupdate.` });
              break;
              
            case 'dellist':
              if (args.length < 1) {
                await sock.sendMessage(chatId, { text: '❌ Format salah! Gunakan: .dellist [keyword]' });
                break;
              }
              
              const delKeyword = args[0];
              const delLists = readLists();
              
              if (!delLists[chatId] || !delLists[chatId][delKeyword]) {
                await sock.sendMessage(chatId, { text: `❌ List "${delKeyword}" tidak ditemukan.` });
                break;
              }
              
              delete delLists[chatId][delKeyword];
              writeLists(delLists);
              
              await sock.sendMessage(chatId, { text: `✅ List "${delKeyword}" telah dihapus.` });
              break;
              
            case 'hidetag':
            case 'h':
              const mentionText = args.join(' ');
              const mentionJids = groupMetadata.participants.map(p => p.id);
              
              await sock.sendMessage(chatId, { 
                text: mentionText || 'Attention everyone!', 
                mentions: mentionJids 
              });
              break;
              
            case 'kick':
              if (args.length < 1) {
                await sock.sendMessage(chatId, { text: '❌ Format salah! Gunakan: .kick @user' });
                break;
              }
              
              // Extract the mentioned user
              if (!message.message.extendedTextMessage || !message.message.extendedTextMessage.contextInfo || !message.message.extendedTextMessage.contextInfo.mentionedJid) {
                await sock.sendMessage(chatId, { text: '❌ Tag pengguna yang ingin dikeluarkan!' });
                break;
              }
              
              const kickUser = message.message.extendedTextMessage.contextInfo.mentionedJid[0];
              
              try {
                await sock.groupParticipantsUpdate(chatId, [kickUser], 'remove');
                await sock.sendMessage(chatId, { text: '👢 Pengguna telah dikeluarkan dari grup.' });
              } catch (error) {
                await sock.sendMessage(chatId, { text: '❌ Gagal mengeluarkan pengguna.' });
              }
              break;
          }
        } else if (['tutup', 'buka', 'setwelcome', 'setbye', 'addlist', 'updatelist', 'dellist', 'hidetag', 'h', 'kick'].includes(command.toLowerCase())) {
          await sock.sendMessage(chatId, { text: '❌ Maaf, perintah ini hanya untuk admin.' });
        }
      }
      
      // Pengecekan trigger list untuk semua anggota
      const lists = readLists();
      if (lists[chatId] && lists[chatId][messageContent]) {
        await sock.sendMessage(chatId, { text: lists[chatId][messageContent] });
      }
    }
  });
  
  // Event handler untuk grup participants update
  sock.ev.on('group-participants.update', async (update) => {
    const { id, participants, action } = update;
    const groupConfigs = readGroupConfig();
    const groupConfig = groupConfigs[id] || { isOpen: true, welcome: '', bye: '' };
    
    // Handle untuk member bergabung
    if (action === 'add' && groupConfig.welcome) {
      for (const participant of participants) {
        const welcomeMsg = groupConfig.welcome.replace('@user', `@${participant.split('@')[0]}`);
        await sock.sendMessage(id, { 
          text: welcomeMsg,
          mentions: [participant]
        });
      }
    }
    
    // Handle untuk member keluar
    if (action === 'remove' && groupConfig.bye) {
      for (const participant of participants) {
        const byeMsg = groupConfig.bye.replace('@user', `@${participant.split('@')[0]}`);
        await sock.sendMessage(id, { 
          text: byeMsg,
          mentions: [participant]
        });
      }
    }
  });
}

// Memulai bot
startBot();
