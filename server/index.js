const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const pino = require('pino');
const fs = require('fs');
const net = require('net');
const dns = require('dns');

// Evita timeout quando o servidor tem DNS/IPv6 instável: Node pode tentar AAAA primeiro.
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) {}

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




function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function normalizarIP(input) {
  if (!input) return '';
  let ip = safeDecodeURIComponent(String(input).trim());
  ip = ip.replace(/^['"]+|['"]+$/g, '').trim();

  // Aceita URLs como https://rdap.registro.br/ip/138.121.119.74 ou parâmetros ?id=...
  const q = ip.match(/[?&]id=([^&\s]+)/);
  if (q) ip = safeDecodeURIComponent(q[1].trim());

  const path = ip.match(/\/ip\/([^/?#\s]+)/i);
  if (path) ip = safeDecodeURIComponent(path[1].trim());

  // Remove colchetes e porta em IPv6 no formato correto: [2804:...:c701]:52386
  const ipv6ComPorta = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (ipv6ComPorta) ip = ipv6ComPorta[1].trim();

  // IPv4 com porta: 138.121.119.74:52386
  const ipv4ComPorta = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/);
  if (ipv4ComPorta) ip = ipv4ComPorta[1];

  // Alguns extratos chegam com IPv6 sem colchetes e com porta no fim.
  // Ex.: 2804:...:cf60:64734 tem 9 grupos e é inválido; removendo o último vira IPv6 válido.
  if (ip.includes(':') && net.isIP(ip) !== 6) {
    const parts = ip.split(':');
    const last = parts[parts.length - 1];
    const candidate = parts.slice(0, -1).join(':');
    if (/^\d{2,6}$/.test(last) && net.isIP(candidate) === 6) {
      ip = candidate;
    }
  }

  return ip.trim();
}

function vcardRawValue(entity, field) {
  const vcard = entity?.vcardArray?.[1] || [];
  const item = vcard.find(v => Array.isArray(v) && v[0] === field);
  return item ? item[3] : null;
}

function vcardValue(entity, field) {
  const raw = vcardRawValue(entity, field);
  if (raw == null) return null;

  if (Array.isArray(raw)) {
    const txt = raw.map(v => (v == null ? '' : String(v).trim())).filter(Boolean).join(' ');
    return txt || null;
  }

  if (typeof raw === 'object') {
    const txt = raw['country-name'] || raw.country || raw.label ||
      Object.values(raw).map(v => (v == null ? '' : String(v).trim())).filter(Boolean).join(' ');
    return txt || null;
  }

  const txt = String(raw).trim();
  return txt || null;
}

function vcardCountry(entity) {
  const adr = vcardRawValue(entity, 'adr');
  if (Array.isArray(adr)) return String(adr[6] || '').trim() || null;
  if (adr && typeof adr === 'object') return adr['country-name'] || adr.country || null;
  return null;
}

function rdapIpPath(ip) {
  // Não use encodeURIComponent no IP inteiro. Em IPv6, os dois-pontos fazem parte do caminho RDAP.
  // O registro.br aceita /ip/2804:f50::/32 e pode rejeitar /ip/2804%3Af50%3A...
  return String(ip || '').trim();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithTimeout(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      headers: {
        Accept: 'application/rdap+json, application/json',
        'User-Agent': 'INTEL-RDAP/1.0'
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    const ms = Date.now() - started;
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}

    if (!r.ok) {
      return {
        ok: false,
        status: r.status,
        url,
        ms,
        error: `HTTP ${r.status}`,
        body: text ? text.slice(0, 180) : ''
      };
    }

    if (!data) {
      return {
        ok: false,
        status: r.status,
        url,
        ms,
        error: 'resposta RDAP não veio em JSON',
        body: text ? text.slice(0, 180) : ''
      };
    }

    return { ok: true, status: r.status, data, url, ms };
  } catch (e) {
    const ms = Date.now() - started;
    return {
      ok: false,
      url,
      ms,
      error: e.name === 'AbortError' ? 'timeout' : (e.message || String(e)),
      code: e.code || e.cause?.code || null
    };
  } finally {
    clearTimeout(timer);
  }
}

// Detecta faixas tipicamente LACNIC/Brasil para consultar primeiro o registro.br.
function isBrazilianOrLacnicIP(ip) {
  if (!ip) return false;
  if (ip.includes(':')) {
    return /^(2800|2801|2802|2803|2804|2805|2806|2807|2001:12)/i.test(ip);
  }
  const first = parseInt(ip.split('.')[0], 10);
  if ([177, 179, 186, 187, 188, 189, 191, 200].includes(first)) return true;
  if ([45, 138, 143, 170].includes(first)) return true;
  return false;
}

function rdapEndpoints(ip) {
  const eip = rdapIpPath(ip);

  if (isBrazilianOrLacnicIP(ip)) {
    return [
      `https://rdap.registro.br/ip/${eip}`,
      `https://rdap.lacnic.net/rdap/ip/${eip}`,
      `https://rdap.org/ip/${eip}`,
      `https://rdap-bootstrap.arin.net/bootstrap/ip/${eip}`,
    ];
  }

  return [
    `https://rdap-bootstrap.arin.net/bootstrap/ip/${eip}`,
    `https://rdap.org/ip/${eip}`,
    `https://rdap.registro.br/ip/${eip}`,
    `https://rdap.lacnic.net/rdap/ip/${eip}`,
    `https://rdap.arin.net/registry/ip/${eip}`,
    `https://rdap.db.ripe.net/ip/${eip}`,
    `https://rdap.apnic.net/ip/${eip}`,
    `https://rdap.afrinic.net/rdap/ip/${eip}`,
  ];
}

function tentativaResumo(r) {
  return {
    url: r.url,
    host: (() => { try { return new URL(r.url).hostname; } catch (_) { return ''; } })(),
    ok: !!r.ok,
    status: r.status || null,
    ms: r.ms || null,
    error: r.error || null,
    code: r.code || null
  };
}

function isTransientRdapError(r) {
  const msg = String(r?.error || '').toLowerCase();
  const code = String(r?.code || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('fetch failed') ||
    msg.includes('network') || msg.includes('socket') ||
    ['econnreset', 'etimedout', 'eai_again', 'enotfound', 'und_err_connect_timeout'].includes(code);
}

// Consulta primária em PARALELO (os dois primeiros endpoints ao mesmo tempo).
// O mais rápido vence. Se ambos falharem, tenta os demais em sequência.
// Isso reduz drasticamente o tempo de resposta para IPs brasileiros:
// registro.br e lacnic são disparados juntos; o primeiro a responder é usado.
async function queryRdapWithRace(endpoints) {
  const attempts = [];
  if (!endpoints || !endpoints.length) return { ok: false, attempts };

  const primary  = endpoints.slice(0, 2);
  const fallback = endpoints.slice(2);

  // Tenta os dois endpoints primários em paralelo — o primeiro válido vence.
  const primaryResults = await Promise.allSettled(
    primary.map(url =>
      fetchJsonWithTimeout(url).then(r => {
        if (!r.ok || !r.data) throw Object.assign(new Error(r.error || `HTTP ${r.status}`), { rdapResult: r });
        return r;
      })
    )
  );

  for (const res of primaryResults) {
    if (res.status === 'fulfilled' && res.value?.ok && res.value?.data) {
      attempts.push(tentativaResumo(res.value));
      return { ...res.value, attempts };
    }
    if (res.status === 'rejected') {
      const r = res.reason?.rdapResult;
      if (r) attempts.push(tentativaResumo(r));
    }
  }

  // Fallback sequencial com retry para erros transitórios.
  for (const url of fallback) {
    let r = await fetchJsonWithTimeout(url);
    attempts.push(tentativaResumo(r));
    if (r.ok && r.data) return { ...r, attempts };

    if (isTransientRdapError(r)) {
      await delay(600);
      r = await fetchJsonWithTimeout(url, 15000);
      attempts.push({ ...tentativaResumo(r), retry: true });
      if (r.ok && r.data) return { ...r, attempts };
    }
  }

  return { ok: false, attempts };
}

function extrairASN(data) {
  const candidates = [
    data?.nicbr_autnum ? `AS${data.nicbr_autnum}` : null,
    data?.arin_originas0_asns?.[0],
    data?.autnums?.[0]?.handle,
    data?.handle?.match(/AS\d+/i)?.[0],
    data?.name?.match(/AS\d+/i)?.[0],
  ].filter(Boolean);

  const asn = candidates[0];
  if (!asn) return null;
  return String(asn).toUpperCase().startsWith('AS') ? String(asn).toUpperCase() : `AS${asn}`;
}

function parseRdapResult(data, ip, fonte) {
  const asn = extrairASN(data);
  let titular = null;
  let documento = null;
  let responsavel = null;
  let pais = data.country || null;
  let criado = null;
  let alterado = null;
  const contatos = [];

  (data.events || []).forEach(ev => {
    if (ev.eventAction === 'registration') criado = ev.eventDate?.split('T')[0];
    if (ev.eventAction === 'last changed') alterado = ev.eventDate?.split('T')[0];
  });

  let registrantEncontrado = false;

  const processEntity = (entity) => {
    const nome = vcardValue(entity, 'fn');
    const org = vcardValue(entity, 'org');
    const email = vcardValue(entity, 'email');
    const paisVal = vcardCountry(entity);
    const roles = (Array.isArray(entity.roles) ? entity.roles : []).map(r => String(r || '').toLowerCase());
    const isRegistrant = roles.includes('registrant');
    const nomePreferencial = org || nome || null;

    let doc = null;
    (entity.publicIds || []).forEach(pid => {
      if (pid.identifier) doc = pid.identifier;
    });

    let entCriado = null;
    let entAlterado = null;
    (entity.events || []).forEach(ev => {
      if (ev.eventAction === 'registration') entCriado = ev.eventDate?.split('T')[0];
      if (ev.eventAction === 'last changed') entAlterado = ev.eventDate?.split('T')[0];
    });

    // O registrante é o titular real do bloco e deve sobrescrever contato técnico/administrativo.
    if (isRegistrant) {
      if (nomePreferencial) titular = nomePreferencial;
      if (doc) documento = doc;
      responsavel = nome || org || responsavel;
      pais = pais || paisVal;
      criado = criado || entCriado;
      alterado = alterado || entAlterado;
      registrantEncontrado = registrantEncontrado || !!(nomePreferencial || doc);
    } else if (!registrantEncontrado && !titular && nomePreferencial) {
      titular = nomePreferencial;
      if (doc) documento = doc;
      responsavel = nome || org || responsavel;
      pais = pais || paisVal;
      criado = criado || entCriado;
      alterado = alterado || entAlterado;
    }

    if (roles.some(r => ['abuse', 'technical', 'administrative', 'noc'].includes(r))) {
      contatos.push({
        id: entity.handle || '',
        nome: nome || org,
        email,
        pais: paisVal,
        criado: entCriado,
        alterado: entAlterado
      });
    }

    (entity.entities || []).forEach(processEntity);
  };

  (data.entities || []).forEach(processEntity);

  titular = titular || data.name || data.handle || null;
  responsavel = responsavel || titular;

  const delegacoes = [];
  (data.networks || data.ips || []).forEach(netw => {
    if (netw.handle) {
      const dns = (netw.nameservers || []).map(ns => ns.ldhName || ns.unicodeName || '').filter(Boolean);
      delegacoes.push({ bloco: netw.handle, dns });
    }
  });

  if (delegacoes.length === 0 && data.handle) {
    const dns = (data.nameservers || []).map(ns => ns.ldhName || ns.unicodeName || '').filter(Boolean);
    delegacoes.push({ bloco: data.handle, dns });
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
    delegacoes,
    contatos: contatos.filter(c => c.nome || c.email)
  };
}

async function consultarIpRdap(rawInput, opts = {}) {
  const ip = normalizarIP(rawInput);
  if (!ip) return { ok: false, error: 'IP obrigatório' };

  if (!net.isIP(ip)) {
    return { ok: false, error: `IP inválido após normalização: ${ip}` };
  }

  if (!opts.nocache && ipCache[ip]?.ok) return { ...ipCache[ip], cached: true };

  const endpoints = rdapEndpoints(ip);
  const rdapResult = await queryRdapWithRace(endpoints);

  if (!rdapResult || !rdapResult.ok) {
    console.warn('[INTEL] RDAP não localizou IP:', ip, rdapResult?.attempts || []);
    const attempts = rdapResult?.attempts || [];
    const transient = attempts.some(a => a.error && !String(a.error).startsWith('HTTP 4'));
    return {
      ok: false,
      temporary: transient,
      error: transient
        ? 'Falha temporária ao consultar RDAP a partir do servidor'
        : 'IP não encontrado nos servidores RDAP consultados',
      attempts
    };
  }

  const resposta = {
    ok: true,
    result: parseRdapResult(rdapResult.data, ip, rdapResult.url),
    attempts: rdapResult.attempts || []
  };

  ipCache[ip] = resposta;
  return resposta;
}

// Nova rota preferencial: evita problemas de IPv6 em parâmetro de caminho.
app.get('/api/ip', async (req, res) => {
  try {
    const resposta = await consultarIpRdap(req.query.id || req.query.ip || '', {
      nocache: String(req.query.nocache || '') === '1'
    });
    res.status(200).json(resposta);
  } catch(e) {
    console.error('[INTEL] Erro consulta IP:', e.message);
    res.json({ ok: false, temporary: true, error: e.message });
  }
});

// Diagnóstico cru: use quando aparecer “falha temporária” para ver status/timeout por endpoint.
app.get('/api/ip/debug', async (req, res) => {
  try {
    const raw = req.query.id || req.query.ip || '';
    const ip = normalizarIP(raw);
    if (!ip) return res.json({ ok: false, error: 'IP obrigatório' });
    if (!net.isIP(ip)) return res.json({ ok: false, error: `IP inválido após normalização: ${ip}` });
    const endpoints = rdapEndpoints(ip);
    const rdapResult = await queryRdapWithRace(endpoints);
    res.json({ ok: !!rdapResult?.ok, ip, endpoints, attempts: rdapResult?.attempts || [], result: rdapResult?.ok ? parseRdapResult(rdapResult.data, ip, rdapResult.url) : null });
  } catch(e) {
    console.error('[INTEL] Erro diagnóstico IP:', e.message);
    res.json({ ok: false, temporary: true, error: e.message });
  }
});

// Rota antiga mantida para compatibilidade com links e telas já abertas.
app.get('/api/ip/:ip', async (req, res) => {
  try {
    const resposta = await consultarIpRdap(req.params.ip);
    res.status(resposta.ok ? 200 : 200).json(resposta);
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
