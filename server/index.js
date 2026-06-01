const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const pino = require('pino');
const fs = require('fs');
const net = require('net');

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
let ipCache = {};

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
  ipCache = {};
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




function safeDecode(v) {
  try { return decodeURIComponent(v); } catch (_) { return v; }
}

function limparPontas(v) {
  return String(v || '')
    .trim()
    .replace(/^[<("'`]+/, '')
    .replace(/[>)"'`,;]+$/, '')
    .trim();
}

function normalizarIP(input) {
  if (!input) return '';

  let ip = limparPontas(safeDecode(String(input)));

  // Aceita URLs como https://rdap.registro.br/ip/138.121.119.74,
  // https://rdap.registro.br/ip/2804:f50::/32 ou parâmetros ?id=...
  const q = ip.match(/[?&](?:id|ip)=([^&#\s]+)/i);
  if (q) ip = limparPontas(safeDecode(q[1]));

  const pathMatch = ip.match(/\/(?:rdap\/)?ip\/([^?#\s]+)/i);
  if (pathMatch) ip = limparPontas(safeDecode(pathMatch[1]));

  // Remove prefixo textual comum em planilhas/logs.
  ip = ip.replace(/^ip\s*[:=]\s*/i, '').trim();

  // IPv6 com porta: [2804:...:c701]:52386
  const ipv6ComPorta = ip.match(/^\[([^\]]+)\](?::\d{1,5})?$/);
  if (ipv6ComPorta) ip = ipv6ComPorta[1];

  // IPv4 com porta: 138.121.119.74:52386
  const ipv4ComPorta = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/);
  if (ipv4ComPorta) ip = ipv4ComPorta[1];

  // IPv6 sem colchetes, mas com porta indevidamente adicionada ao final.
  // Só corta quando há 9+ blocos; com 8 blocos pode ser IPv6 válido.
  if (ip.includes(':') && !ip.includes('/')) {
    const parts = ip.split(':');
    const last = parts[parts.length - 1];
    const maybePort = /^\d{1,5}$/.test(last) && Number(last) >= 1 && Number(last) <= 65535;
    if (!ip.includes('::') && parts.length > 8 && maybePort) {
      const semPorta = parts.slice(0, -1).join(':');
      if (net.isIP(semPorta) === 6) ip = semPorta;
    }
  }

  // Mantém CIDR, pois o RDAP do Registro.br aceita bloco como 177.154.23.0/24.
  const [addr, cidr] = ip.split('/');
  if (cidr !== undefined) {
    const n = Number(cidr);
    if (!Number.isInteger(n)) return '';
    const version = net.isIP(addr);
    if ((version === 4 && n >= 0 && n <= 32) || (version === 6 && n >= 0 && n <= 128)) {
      return `${addr}/${n}`;
    }
    return '';
  }

  return net.isIP(ip) ? ip : '';
}

function rdapPathIP(ip) {
  // Colon em IPv6 pode ficar literal no path; slash de CIDR precisa ser codificado.
  return encodeURIComponent(ip).replace(/%3A/gi, ':');
}

function vcardValue(entity, field) {
  const vcard = entity?.vcardArray?.[1] || [];
  const item = vcard.find(v => Array.isArray(v) && String(v[0] || '').toLowerCase() === String(field).toLowerCase());
  if (!item) return null;

  const value = item[3];
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    return value['country-name'] || value.label || Object.values(value).filter(Boolean).join(', ') || null;
  }
  return value ?? null;
}

function entityDisplayName(entity) {
  const org = vcardValue(entity, 'org');
  const fn = vcardValue(entity, 'fn');
  const kind = String(vcardValue(entity, 'kind') || '').toLowerCase();

  // No RDAP do Registro.br, empresas costumam vir como kind=org e nome no fn.
  if (org) return String(org).trim();
  if (fn) return String(fn).trim();
  return entity?.handle || null;
}

function entityCountry(entity) {
  const adr = vcardValue(entity, 'adr');
  if (!adr) return null;
  if (typeof adr === 'string') {
    const parts = adr.split(',').map(s => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || null;
  }
  return null;
}

function eventDate(obj, action) {
  const ev = (obj?.events || []).find(e => e.eventAction === action);
  return ev?.eventDate ? String(ev.eventDate).split('T')[0] : null;
}

async function fetchJsonWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        Accept: 'application/rdap+json, application/json',
        'User-Agent': 'WhatsApp-Intel-RDAP/1.0'
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    let data = null;
    try { data = await r.json(); } catch (_) {}

    if (!r.ok) return { ok: false, status: r.status, url, data };
    if (!data || typeof data !== 'object') return { ok: false, status: 'json-invalido', url, data };

    // Evita aceitar como "sucesso" um corpo RDAP de erro ou uma resposta sem objeto útil.
    if (data.errorCode || data.title === 'Not Found') {
      return { ok: false, status: data.errorCode || data.title, url, data };
    }

    return { ok: true, data, url };
  } finally {
    clearTimeout(timer);
  }
}

function rdapEndpoints(ip) {
  const eip = rdapPathIP(ip);

  // TESTE SOLICITADO: consultar somente o Registro.br para todos os IPs.
  // Se o Registro.br não localizar o IP, o sistema sinaliza como provedor externo.
  return [
    `https://rdap.registro.br/ip/${eip}`,
  ];
}

function respostaProvedorExterno(ip, fonte, tentativas, motivo = 'IP não retornou dados no Registro.br') {
  return {
    ok: true,
    result: {
      ip,
      asn: null,
      titular: 'Provedor externo: consulte lacnic.net',
      documento: null,
      responsavel: null,
      pais: 'EXTERNO/NAO-BR',
      criado: null,
      alterado: null,
      fonte,
      handle: null,
      blocoInicio: null,
      blocoFim: null,
      tipo: null,
      delegacoes: [],
      contatos: [],
      externo: true,
      observacao: motivo
    },
    tentativas
  };
}

function extrairRdap(data, ip, fonte) {
  const asn = data.nicbr_autnum
    ? `AS${data.nicbr_autnum}`
    : (data.arin_originas0_asns?.[0]
      || data.autnums?.[0]?.handle
      || data.handle?.match(/AS\d+/i)?.[0]
      || null);

  let pais = data.country || null;
  let criado = eventDate(data, 'registration');
  let alterado = eventDate(data, 'last changed');
  const contatos = [];
  const candidatos = [];

  const processEntity = (entity, depth = 0) => {
    if (!entity) return;

    const nome = entityDisplayName(entity);
    const email = vcardValue(entity, 'email');
    const roles = Array.isArray(entity.roles) ? entity.roles.map(r => String(r).toLowerCase()) : [];
    const doc = (entity.publicIds || []).map(pid => pid.identifier).filter(Boolean)[0] || null;
    const entCriado = eventDate(entity, 'registration');
    const entAlterado = eventDate(entity, 'last changed');
    const paisVal = entityCountry(entity);
    const legalRepresentative = entity.legalRepresentative || entity.nicbr_responsible || null;

    let score = 0;
    if (roles.includes('registrant')) score += 100;
    if (roles.includes('administrative')) score += 40;
    if (roles.includes('technical')) score += 25;
    if (roles.includes('abuse')) score -= 20;
    if (doc) score += 15;
    if (nome) score += 5;
    score -= depth;

    if (nome || doc || legalRepresentative) {
      candidatos.push({
        score,
        roles,
        nome,
        documento: doc,
        responsavel: legalRepresentative || null,
        pais: paisVal,
        criado: entCriado,
        alterado: entAlterado
      });
    }

    if (roles.some(r => ['abuse', 'technical', 'administrative', 'noc'].includes(r))) {
      contatos.push({
        id: entity.handle || '',
        tipo: roles.join(', '),
        nome,
        email,
        pais: paisVal,
        criado: entCriado,
        alterado: entAlterado
      });
    }

    (entity.entities || []).forEach(child => processEntity(child, depth + 1));
  };

  (data.entities || []).forEach(entity => processEntity(entity, 0));

  candidatos.sort((a, b) => b.score - a.score);
  const principal = candidatos[0] || {};

  const titular = principal.nome || data.name || data.handle || null;
  const documento = principal.documento || null;
  const responsavel = principal.responsavel || principal.nome || titular || null;
  pais = pais || principal.pais || null;
  criado = criado || principal.criado || null;
  alterado = alterado || principal.alterado || null;

  const delegacoes = [];
  (data.networks || data.ips || []).forEach(netw => {
    if (netw.handle) {
      const dns = (netw.nameservers || []).map(ns => ns.ldhName || ns.unicodeName || '').filter(Boolean);
      delegacoes.push({ bloco: netw.handle, dns });
    }
  });

  if (delegacoes.length === 0 && data.handle) {
    const dns = (data.nameservers || []).map(ns => ns.ldhName || ns.unicodeName || '').filter(Boolean);
    delegacoes.push({
      bloco: data.handle,
      inicio: data.startAddress || null,
      fim: data.endAddress || null,
      dns
    });
  }

  return {
    ip,
    asn,
    titular,
    documento,
    responsavel,
    pais,
    criado,
    alterado,
    fonte,
    handle: data.handle || null,
    blocoInicio: data.startAddress || null,
    blocoFim: data.endAddress || null,
    tipo: data.type || null,
    delegacoes,
    contatos: contatos.filter(c => c.nome || c.email)
  };
}

function temIdentificacaoUtil(result) {
  return !!(result?.titular || result?.documento || result?.asn || result?.handle);
}

app.get('/api/ip/:ip', async (req, res) => {
  const ip = normalizarIP(req.params.ip);
  if (!ip) return res.status(400).json({ ok: false, error: 'IP inválido ou obrigatório' });

  // Cache em memória: guarda respostas positivas, inclusive a marcação de provedor externo.
  if (ipCache[ip]?.ok) return res.json(ipCache[ip]);

  const tentativas = [];
  const urlRegistro = rdapEndpoints(ip)[0];

  try {
    const r = await fetchJsonWithTimeout(urlRegistro);

    if (!r.ok) {
      const motivo = `Registro.br não retornou cadastro brasileiro para este IP. Status: ${r.status}`;
      tentativas.push(`${urlRegistro} => HTTP/ERRO ${r.status}`);
      const resposta = respostaProvedorExterno(ip, urlRegistro, tentativas, motivo);
      ipCache[ip] = resposta;
      return res.json(resposta);
    }

    const result = extrairRdap(r.data, ip, r.url);
    tentativas.push(`${urlRegistro} => OK${result.titular ? ' titular=' + result.titular : ''}`);

    if (temIdentificacaoUtil(result)) {
      const resposta = { ok: true, result, tentativas };
      ipCache[ip] = resposta;
      return res.json(resposta);
    }

    const resposta = respostaProvedorExterno(
      ip,
      urlRegistro,
      tentativas,
      'Registro.br respondeu, mas não retornou titular/ASN/bloco útil para identificação.'
    );
    ipCache[ip] = resposta;
    return res.json(resposta);

  } catch(e) {
    const msg = e.name === 'AbortError' ? 'timeout' : e.message;
    tentativas.push(`${urlRegistro} => ${msg}`);

    // Em falha real de conexão, não marque como externo, porque pode ser indisponibilidade temporária.
    console.error('[INTEL] Erro consulta IP Registro.br:', ip, msg);
    return res.json({
      ok: false,
      error: `Falha temporária ao consultar Registro.br: ${msg}`,
      tentativas
    });
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
