const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const pino = require('pino');
const fs = require('fs');

// Captura erros globais para evitar que o servidor encerre
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
    celcoinTokenExpiry = Date.now() + (2300 * 1000); // 2300s de margem
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
    // Remove codigo do pais +55 se existir
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
    console.log('[INTEL] Operadora:', number, '->', data.nameProvider || 'N/A');
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

    console.log('[INTEL] Pasta de sessao:', AUTH_DIR);

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
          console.log('[INTEL] QR Code gerado! Acesse o dashboard para escanear.');
        }

        if (connection === 'open') {
          connectionStatus = 'connected';
          qrCodeData = null;
          console.log('[INTEL] Conectado ao WhatsApp com sucesso!');
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;

          connectionStatus = 'disconnected';

          console.log('[INTEL] Conexao encerrada. Codigo:', code);

          const shouldClearSession =
            code === DisconnectReason.loggedOut;

          if (shouldClearSession) {
            console.log('[INTEL] Sessao invalida. Limpando auth_info...');

            try {
              fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            } catch (e) {}

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

        if (messagesCache[jid].length > 200) {
          messagesCache[jid] = messagesCache[jid].slice(-200);
        }
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

  for (let i = 0; i < numbers.length; i++) {
    const raw = numbers[i].trim();
    const number = raw.replace(/\D/g, '');
    const jid = `${number}@s.whatsapp.net`;
    let result = { number: raw, photoUrl: null, found: false, index: i };

    if (profileCache[number]) {
      result = { ...profileCache[number], number: raw, index: i };
    } else {
      let photoUrl = null;
      let about = null;
      let found = false;
      let isBusiness = false;
      let businessName = null;
      let businessCategory = null;
      let businessDescription = null;
      let noWhatsApp = false;

      // Verifica se o numero tem WhatsApp instalado
      try {
        const [waResult] = await sock.onWhatsApp(number);
        if (!waResult || !waResult.exists) {
          noWhatsApp = true;
          result = { number: raw, photoUrl: null, about: null, found: false, noWhatsApp: true, isBusiness: false, businessName: null, businessCategory: null, businessDescription: null, index: i };
          profileCache[number] = { ...result };
          res.write(`data: ${JSON.stringify({ ...result, progress: i + 1, total: numbers.length })}

`);
          if (i < numbers.length - 1) await new Promise(r => setTimeout(r, 900 + Math.random() * 600));
          continue;
        }
      } catch (e) {}

      try {
        const bizProfile = await sock.getBusinessProfile(jid);
        if (bizProfile && bizProfile.wid) {
          isBusiness = true;
          found = true;
          businessName = bizProfile.name || null;
          businessCategory = bizProfile.category || null;
          businessDescription = bizProfile.description || null;
          about = bizProfile.description || null;
          console.log('[INTEL] Conta Business detectada:', raw, businessName);
        }
      } catch (e) {}

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

      if (!about) {
        try {
          const statusResult = await sock.fetchStatus(jid);
          let rawStatus = statusResult;
          if (Array.isArray(rawStatus)) rawStatus = rawStatus[0];
          if (rawStatus && typeof rawStatus === 'object') rawStatus = rawStatus.status ?? null;
          if (rawStatus && typeof rawStatus === 'object') rawStatus = rawStatus.status ?? null;

          about = (typeof rawStatus === 'string' && rawStatus.trim()) ? rawStatus.trim() : null;

          const defaults = [
            'Hey there! I am using WhatsApp.',
            'Olá! Eu estou usando o WhatsApp.',
            'Available',
            'Busy',
          ];
          if (about && defaults.includes(about)) about = null;
        } catch (e) {}
      }

      // Consulta operadora via CelCoin
      let operadora = null;
      try {
        operadora = await consultarOperadora(number);
      } catch(e) {}

      result = { number: raw, photoUrl, about, found, noWhatsApp, isBusiness, businessName, businessCategory, businessDescription, operadora, index: i };
      profileCache[number] = { number: raw, photoUrl, about, found, noWhatsApp, isBusiness, businessName, businessCategory, businessDescription, operadora };
    }

    res.write(`data: ${JSON.stringify({ ...result, progress: i + 1, total: numbers.length })}\n\n`);
    if (i < numbers.length - 1) await new Promise(r => setTimeout(r, 900 + Math.random() * 600));
  }

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
    return (
      String(chat.name || '').toLowerCase().includes(q) ||
      String(chat.id || '').toLowerCase().includes(q)
    );
  });
  res.json({ ok: true, chats: chats.slice(0, 200) });
});

app.get('/api/chats/:jid/messages', (req, res) => {
  const jid = req.params.jid;
  const messages = messagesCache[jid] || [];
  res.json({ ok: true, jid, messages: messages.slice(-50) });
});


app.get('/api/ip/:ip', async (req, res) => {
  const ip = req.params.ip;
  try {
    // Tenta registro.br primeiro (IPs brasileiros), depois LACNIC, depois ARIN
    const endpoints = [
      `https://rdap.registro.br/ip/${ip}`,
      `https://rdap.lacnic.net/rdap/ip/${ip}`,
      `https://rdap.arin.net/registry/ip/${ip}`,
    ];

    let data = null;
    for (const url of endpoints) {
      try {
        const r = await fetch(url, { headers: { Accept: 'application/rdap+json' } });
        if (r.ok) { data = await r.json(); break; }
      } catch(e) {}
    }

    if (!data) return res.json({ ok: false, error: 'IP não encontrado em nenhum registro' });

    // Extrai ASN
    const asn = data.arin_originas0_asns?.[0]
      || data.autnums?.[0]?.handle
      || null;

    // Extrai entidades
    let titular = null, documento = null, responsavel = null, pais = null;
    let criado = null, alterado = null;
    const contatos = [];

    // Datas do objeto principal
    (data.events || []).forEach(ev => {
      if (ev.eventAction === 'registration') criado = ev.eventDate?.split('T')[0];
      if (ev.eventAction === 'last changed') alterado = ev.eventDate?.split('T')[0];
    });

    // Processa entidades
    const processEntity = (entity, tipo) => {
      const vcard = entity.vcardArray?.[1] || [];
      const nome = vcard.find(v => v[0] === 'fn')?.[3] || null;
      const email = vcard.find(v => v[0] === 'email')?.[3] || null;
      const org = vcard.find(v => v[0] === 'org')?.[3] || null;
      const paisVal = vcard.find(v => v[0] === 'adr')?.[3]?.['country-name'] || null;

      // Documento (CNPJ/CPF nos remarks ou publicIds)
      let doc = null;
      (entity.publicIds || []).forEach(pid => { if (pid.identifier) doc = pid.identifier; });

      let entCriado = null, entAlterado = null;
      (entity.events || []).forEach(ev => {
        if (ev.eventAction === 'registration') entCriado = ev.eventDate?.split('T')[0];
        if (ev.eventAction === 'last changed') entAlterado = ev.eventDate?.split('T')[0];
      });

      const roles = entity.roles || [];
      if (roles.includes('registrant')) {
        titular = org || nome;
        documento = doc;
        responsavel = nome;
        pais = paisVal;
        if (!criado && entCriado) criado = entCriado;
        if (!alterado && entAlterado) alterado = entAlterado;
      }

      // Contatos (abuse, technical, administrative)
      if (roles.some(r => ['abuse','technical','administrative','noc'].includes(r))) {
        contatos.push({
          id: entity.handle || '',
          nome: nome || org,
          email,
          pais: paisVal,
          criado: entCriado,
          alterado: entAlterado
        });
      }

      // Processa sub-entidades
      (entity.entities || []).forEach(sub => processEntity(sub, 'sub'));
    };

    (data.entities || []).forEach(e => processEntity(e, 'root'));

    // Delegações (nameservers / subnets)
    const delegacoes = [];
    (data.networks || data.ips || []).forEach(net => {
      if (net.handle) {
        const dns = (net.nameservers || []).map(ns => ns.ldhName || ns.unicodeName || '');
        delegacoes.push({ bloco: net.handle, dns });
      }
    });

    // Tenta extrair bloco do próprio objeto
    if (delegacoes.length === 0 && data.handle) {
      const dns = (data.nameservers || []).map(ns => ns.ldhName || ns.unicodeName || '');
      delegacoes.push({ bloco: data.handle, dns });
    }

    // Tenta pegar país do ipVersion ou endereço
    if (!pais && data.country) pais = data.country;

    // Tenta pegar ASN do ipNetwork
    const asnFinal = asn || (data.handle?.startsWith('AS') ? data.handle : null);

    res.json({
      ok: true,
      result: {
        ip,
        asn: asnFinal,
        titular,
        documento,
        responsavel,
        pais,
        criado,
        alterado,
        delegacoes,
        contatos: contatos.filter(c => c.nome || c.email)
      }
    });

  } catch(e) {
    console.error('[INTEL] Erro consulta IP:', e.message);
    res.json({ ok: false, error: e.message });
  }
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
