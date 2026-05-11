const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const pino = require('pino');
const fs = require('fs');
const pMap = require('p-map'); // npm install p-map

// Captura erros globais
process.on('uncaughtException', (err) => {
  console.error('[INTEL] Erro nao capturado:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[INTEL] Promise rejeitada:', reason);
});

let makeWASocket;
let useMultiFileAuthState;
let DisconnectReason;
let fetchLatestBaileysVersion;
let makeCacheableSignalKeyStore;

async function loadBaileys() {
  if (makeWASocket) return;
  const baileys = await import('@whiskeysockets/baileys');
  makeWASocket = baileys.default;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const AUTH_DIR = process.env.AUTH_DIR || path.resolve(process.cwd(), 'auth_info');

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let profileCache = {};
let chatsCache = [];
let messagesCache = {};

// Cache do token CelCoin
let celcoinToken = null;
let celcoinTokenExpiry = 0;

async function getCelcoinToken() {
  if (celcoinToken && Date.now() < celcoinTokenExpiry) return celcoinToken;
  try {
    const res = await fetch('https://sandbox.openfinance.celcoin.dev/v5/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'client_id=41b44ab9a56440.teste.celcoinapi.v5&client_secret=e9d15cde33024c1494de7480e69b7a18c09d7cd25a8446839b3be82a56a044a3&grant_type=client_credentials'
    });
    const data = await res.json();
    celcoinToken = data.access_token;
    celcoinTokenExpiry = Date.now() + (2300 * 1000);
    return celcoinToken;
  } catch(e) {
    console.error('[INTEL] Erro ao obter token CelCoin:', e.message);
    return null;
  }
}

async function consultarOperadora(number) {
  try {
    const token = await getCelcoinToken();
    if (!token) return null;
    let normalized = number;
    if (normalized.startsWith('55') && normalized.length > 11) {
      normalized = normalized.slice(2);
    }
    const ddd = normalized.slice(0, 2);
    const num = normalized.slice(2);
    const res = await fetch(
      `https://sandbox.openfinance.celcoin.dev/v5/transactions/topups/find-providers?stateCode=${ddd}&PhoneNumber=${num}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    const data = await res.json();
    if (data && data.nameProvider && data.errorCode === '000') {
      return data.nameProvider;
    }
    return null;
  } catch(e) {
    console.error('[INTEL] Erro ao consultar operadora:', e.message);
    return null;
  }
}

async function connectWhatsApp() {
  try {
    await loadBaileys();
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
      console.log('[INTEL] Versao WA:', version.join('.'));
    } catch (e) {
      version = [2, 3000, 1015901307];
      console.log('[INTEL] Usando versao WA padrao:', version.join('.'));
    }

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '22.04'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 3,
      fireInitQueries: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          connectionStatus = 'qr';
          qrCodeData = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'L', width: 300 });
          console.log('[INTEL] QR Code gerado!');
        }
        if (connection === 'open') {
          connectionStatus = 'connected';
          qrCodeData = null;
          console.log('[INTEL] Conectado ao WhatsApp!');
        }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          connectionStatus = 'disconnected';
          console.log('[INTEL] Conexao encerrada. Codigo:', code);
          const shouldClearSession = code === DisconnectReason.loggedOut;
          if (shouldClearSession) {
            try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
            setTimeout(connectWhatsApp, 3000);
          } else {
            setTimeout(connectWhatsApp, 5000);
          }
        }
      } catch (e) {
        console.error('[INTEL] Erro no connection.update:', e.message);
      }
    });

    sock.ev.on('chats.set', ({ chats }) => {
      chatsCache = (chats || [])
        .map((chat) => ({
          id: chat.id,
          name: chat.name || chat.subject || chat.pushName || chat.id,
          unreadCount: chat.unreadCount || 0,
          conversationTimestamp: chat.conversationTimestamp || 0
        }))
        .sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0));
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages || []) {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;
        if (!messagesCache[jid]) messagesCache[jid] = [];
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          msg.message?.documentMessage?.caption ||
          '[sem texto]';
        messagesCache[jid].push({
          id: msg.key?.id,
          fromMe: !!msg.key?.fromMe,
          timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000),
          text
        });
        if (messagesCache[jid].length > 200) messagesCache[jid] = messagesCache[jid].slice(-200);
      }
    });

    sock.ev.on('creds.update', saveCreds);

  } catch (err) {
    console.error('[INTEL] Erro ao conectar WhatsApp:', err.message);
    setTimeout(connectWhatsApp, 5000);
  }
}

app.get('/api/status', (req, res) => {
  res.json({ status: connectionStatus, qr: qrCodeData });
});

app.post('/api/reconnect', async (req, res) => {
  if (sock) { try { sock.end(); } catch (e) {} sock = null; }
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
  connectionStatus = 'disconnected';
  qrCodeData = null;
  profileCache = {};
  chatsCache = [];
  messagesCache = {};
  setTimeout(connectWhatsApp, 1000);
  res.json({ ok: true });
});

app.post('/api/photos/batch', async (req, res) => {
  if (connectionStatus !== 'connected') return res.status(503).json({ error: 'Nao conectado' });
  const { numbers } = req.body;
  if (!numbers?.length) return res.status(400).json({ error: 'Sem numeros' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const processNumber = async (raw, idx) => {
    const number = raw.replace(/\D/g, '');
    const jid = `${number}@s.whatsapp.net`;

    if (profileCache[number]) {
      return { ...profileCache[number], number: raw, index: idx };
    }

    let photoUrl = null;
    let about = null;
    let found = false;
    let isBusiness = false;
    let businessName = null;
    let businessCategory = null;
    let businessDescription = null;
    let noWhatsApp = false;
    let operadora = null;

    // 1) Verifica existência do WhatsApp
    try {
      const [waResult] = await sock.onWhatsApp(number);
      if (!waResult || !waResult.exists) {
        noWhatsApp = true;
        const result = { number: raw, photoUrl: null, about: null, found: false, noWhatsApp: true, isBusiness: false, businessName: null, businessCategory: null, businessDescription: null, operadora: null, index: idx };
        profileCache[number] = { ...result };
        return result;
      }
    } catch (e) {}

    // 2) Business Profile
    try {
      const bizProfile = await sock.getBusinessProfile(jid);
      if (bizProfile && bizProfile.wid) {
        isBusiness = true;
        found = true;
        businessName = bizProfile.name || null;
        businessCategory = bizProfile.category || null;
        businessDescription = bizProfile.description || null;
        about = bizProfile.description || null;
      }
    } catch (e) {}

    // 3) Foto de perfil
    const jidVariants = [jid, number + '@c.us'];
    for (const tryJid of jidVariants) {
      if (photoUrl) break;
      try {
        photoUrl = await sock.profilePictureUrl(tryJid, 'image');
        found = true;
        break;
      } catch (e) {}
      try {
        photoUrl = await sock.profilePictureUrl(tryJid, 'preview');
        found = true;
        break;
      } catch (e) {}
    }
    if (!photoUrl && isBusiness) {
      try {
        photoUrl = await sock.profilePictureUrl(number + '@s.whatsapp.net', 'image');
        found = true;
      } catch (e) {}
    }

    // 4) Sobre/recado
    if (!about) {
      try {
        const statusResult = await sock.fetchStatus(jid);
        let rawStatus = statusResult;
        if (Array.isArray(rawStatus)) rawStatus = rawStatus[0];
        if (rawStatus && typeof rawStatus === 'object') rawStatus = rawStatus.status ?? null;
        if (rawStatus && typeof rawStatus === 'object') rawStatus = rawStatus.status ?? null;
        about = (typeof rawStatus === 'string' && rawStatus.trim()) ? rawStatus.trim() : null;
        const defaults = ['Hey there! I am using WhatsApp.', 'Olá! Eu estou usando o WhatsApp.', 'Available', 'Busy'];
        if (about && defaults.includes(about)) about = null;
      } catch (e) {}
    }

    // 5) Operadora (opcional – comentar para máxima velocidade)
    try {
      operadora = await consultarOperadora(number);
    } catch(e) {}

    const result = { number: raw, photoUrl, about, found, noWhatsApp, isBusiness, businessName, businessCategory, businessDescription, operadora, index: idx };
    profileCache[number] = result;
    return result;
  };

  const concurrency = 5; // Números simultâneos – ajuste conforme necessidade
  let completed = 0;

  const mapper = async (raw, idx) => {
    const resItem = await processNumber(raw, idx);
    completed++;
    res.write(`data: ${JSON.stringify({ ...resItem, progress: completed, total: numbers.length })}\n\n`);
    return resItem;
  };

  await pMap(numbers, mapper, { concurrency });

  res.write('data: {"done":true}\n\n');
  res.end();
});

app.post('/api/cache/clear', (req, res) => {
  profileCache = {};
  res.json({ ok: true });
});

app.get('/api/chats', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const chats = chatsCache.filter((chat) => {
    if (!q) return true;
    return String(chat.name || '').toLowerCase().includes(q) ||
           String(chat.id || '').toLowerCase().includes(q);
  });
  res.json({ ok: true, chats: chats.slice(0, 200) });
});

app.get('/api/chats/:jid/messages', (req, res) => {
  const jid = req.params.jid;
  const messages = messagesCache[jid] || [];
  res.json({ ok: true, jid, messages: messages.slice(-50) });
});

app.get('/api/proxy-image', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('URL obrigatória');
  try {
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https') ? https : http;
    client.get(url, (imgRes) => {
      res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
      imgRes.pipe(res);
    }).on('error', () => res.status(500).send('Erro ao baixar imagem'));
  } catch (e) {
    res.status(500).send('Erro: ' + e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n[INTEL] Servidor rodando na porta ${PORT}`);
  connectWhatsApp();
});