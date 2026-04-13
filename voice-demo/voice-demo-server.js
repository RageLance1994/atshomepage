/**
 * ATS Voice Demo — Backend Server (HARDENED)
 *
 * Guardrail attive:
 *  - Rate limiting per IP  (sessioni + globale)
 *  - CORS whitelist
 *  - Sanificazione e validazione di tutti gli input
 *  - Difesa prompt-injection
 *  - Limiti body size
 *  - Security headers
 *  - IP blocklist + logging degli abusi
 *  - Honeypot field anti-bot
 *  - Demo token opzionale (DEMO_SECRET)
 *  - Budget giornaliero cap (MAX_DAILY_SESSIONS)
 *
 * Avvio:
 *   cp .env.example .env  →  modifica valori  →  npm install  →  node voice-demo-server.js
 */

import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import crypto from 'crypto';

// ── Carica .env ───────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}

// ── Env vars ──────────────────────────────────────────────────────────────────
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY  || '';
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || '';
const PORT                = Number(process.env.PORT || 3000);

// Origini CORS ammesse. Aggiungi il tuo dominio di produzione.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,https://atsco.it,https://www.atsco.it')
  .split(',').map(o => o.trim()).filter(Boolean);

// Token segreto opzionale: se impostato, ogni richiesta deve avere header X-Demo-Token
const DEMO_SECRET = process.env.DEMO_SECRET || '';

// Budget giornaliero massimo (numero di sessioni ElevenLabs al giorno)
const MAX_DAILY_SESSIONS = Number(process.env.MAX_DAILY_SESSIONS || 200);

// ── Contatore sessioni giornaliero (in-memory, reset a mezzanotte) ─────────────
let dailySessions = 0;
let dailyResetDate = new Date().toDateString();
function checkDailyBudget() {
  const today = new Date().toDateString();
  if (today !== dailyResetDate) { dailySessions = 0; dailyResetDate = today; }
  if (dailySessions >= MAX_DAILY_SESSIONS) return false;
  dailySessions++;
  return true;
}

// ── IP Blocklist ──────────────────────────────────────────────────────────────
const PERMANENT_BLOCK = new Set(
  (process.env.BLOCKED_IPS || '').split(',').map(i => i.trim()).filter(Boolean)
);

const abuseTracker = new Map();   // IP → { hits, firstHit }
const tempBlock    = new Map();   // IP → timestamp fine blocco

const ABUSE_THRESHOLD = 10;        // richieste in finestra prima del ban
const ABUSE_WINDOW_MS = 60_000;    // finestra 1 minuto
const TEMP_BLOCK_MS   = 30 * 60_000; // blocco temporaneo 30 minuti

function getClientIP(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function isBlocked(ip) {
  if (PERMANENT_BLOCK.has(ip)) return 'permanent';
  const until = tempBlock.get(ip);
  if (until && Date.now() < until) return 'temporary';
  if (until) tempBlock.delete(ip);
  return false;
}

function trackAbuse(ip) {
  const now = Date.now();
  const entry = abuseTracker.get(ip) || { hits: 0, firstHit: now };
  if (now - entry.firstHit > ABUSE_WINDOW_MS) { entry.hits = 0; entry.firstHit = now; }
  entry.hits++;
  abuseTracker.set(ip, entry);
  if (entry.hits >= ABUSE_THRESHOLD) {
    tempBlock.set(ip, now + TEMP_BLOCK_MS);
    abuseTracker.delete(ip);
    logAbuse(ip, `Auto-bloccato dopo ${ABUSE_THRESHOLD} hit in ${ABUSE_WINDOW_MS / 1000}s`);
    return true;
  }
  return false;
}

// ── Logging abusi ─────────────────────────────────────────────────────────────
const logDir = path.join(__dirname, 'logs');
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

function logAbuse(ip, reason, extra = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), ip, reason, ...extra }) + '\n';
  try { writeFileSync(path.join(logDir, 'abuse.log'), entry, { flag: 'a' }); } catch (_) {}
  console.warn(`[ABUSE] ${ip} — ${reason}`);
}

// ── Rate limiter sliding-window (senza dipendenze) ────────────────────────────
const rateLimitStore = new Map();

function rateLimit({ windowMs, max, keyFn = (r) => getClientIP(r) }) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const hits = (rateLimitStore.get(key) || []).filter(t => now - t < windowMs);
    hits.push(now);
    rateLimitStore.set(key, hits);
    if (hits.length > max) {
      logAbuse(key, `Rate limit: ${hits.length} req in ${windowMs / 1000}s`);
      return res.status(429).json({
        error: 'Troppe richieste. Riprova tra qualche minuto.',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }
    next();
  };
}

// ── Input sanitization + prompt injection defense ─────────────────────────────
const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+(instructions?|prompts?|context)/gi,
  /you\s+are\s+now\s+/gi,
  /system\s*:\s*/gi,
  /\[INST\]/gi,
  /<<SYS>>/gi,
  /<\|im_start\|>/gi,
  /forget\s+(everything|all|your\s+instructions)/gi,
  /act\s+as\s+(if\s+you\s+are|a\s+different)/gi,
  /jailbreak/gi,
  /DAN\s+mode/gi,
  /send\s+.*\s+(api\s*key|secret|password|token)/gi,
  /reveal\s+.*\s+(api\s*key|secret|password)/gi,
  /exfil/gi,
];

function sanitizeText(input, maxLen = 500) {
  if (typeof input !== 'string') return '';
  let text = input
    .slice(0, maxLen)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // control chars
    .replace(/<[^>]*>/g, '')                              // HTML tags
    .trim();
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(text)) {
      logAbuse('input', 'Prompt injection attempt', { snippet: text.slice(0, 120) });
      return '[contenuto rimosso]';
    }
  }
  return text;
}

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '8kb' }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=self');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Demo-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── IP block + abuse tracking ─────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  const ip = getClientIP(req);
  const blocked = isBlocked(ip);
  if (blocked === 'permanent') {
    logAbuse(ip, 'Blocked (permanent list)');
    return res.status(403).json({ error: 'Accesso negato.' });
  }
  if (blocked === 'temporary') {
    return res.status(429).json({ error: 'IP bloccato temporaneamente. Riprova tra 30 minuti.' });
  }
  if (trackAbuse(ip)) {
    return res.status(429).json({ error: 'Troppe richieste. IP bloccato per 30 minuti.' });
  }
  next();
});

// ── Demo token opzionale ──────────────────────────────────────────────────────
app.use('/api/voice-demo/session', (req, res, next) => {
  if (!DEMO_SECRET) return next();
  const provided = req.headers['x-demo-token'] || '';
  if (!crypto.timingSafeEqual(
    Buffer.from(provided.padEnd(64)),
    Buffer.from(DEMO_SECRET.padEnd(64))
  )) {
    logAbuse(getClientIP(req), 'Token non valido');
    return res.status(401).json({ error: 'Token non valido.' });
  }
  next();
});

// ── Rate limits sull'endpoint costoso ─────────────────────────────────────────
const sessionRateLimit = rateLimit({ windowMs: 10 * 60_000, max: 3 });  // 3/IP ogni 10min
const globalRateLimit  = rateLimit({ windowMs: 60_000, max: 30, keyFn: () => '__global__' }); // 30 totali/min

// ── Serve voice-demo.html ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const file = path.join(__dirname, 'voice-demo.html');
  existsSync(file) ? res.sendFile(file) : res.status(404).send('voice-demo.html non trovato.');
});

// ── POST /api/voice-demo/session ──────────────────────────────────────────────
app.post('/api/voice-demo/session', globalRateLimit, sessionRateLimit, async (req, res) => {

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    return res.status(503).json({ error: 'Servizio non configurato.' });
  }

  // Budget giornaliero
  if (!checkDailyBudget()) {
    logAbuse('__budget__', `Daily cap raggiunto (${MAX_DAILY_SESSIONS})`);
    return res.status(503).json({
      error: `Limite giornaliero raggiunto (${MAX_DAILY_SESSIONS} demo). Riprova domani.`
    });
  }

  // Honeypot anti-bot: campo nascosto che un umano non compila mai
  if (req.body?.website || req.body?._gotcha) {
    logAbuse(getClientIP(req), 'Honeypot triggered');
    return res.status(400).json({ error: 'Richiesta non valida.' });
  }

  // Validazione e sanificazione
  const rawPrompt = sanitizeText(String(req.body?.promptDraft || ''), 3000);
  const agentName = sanitizeText(String(req.body?.agentName   || 'Alex'), 40);
  const userName  = sanitizeText(String(req.body?.userName    || ''),     80);
  const company   = sanitizeText(String(req.body?.company     || ''),     80);

  if (!rawPrompt) {
    return res.status(400).json({ error: 'Prompt mancante o non valido.' });
  }

  // Iniezione nome agente
  const effectivePrompt = rawPrompt
    .replace(/\[nome\]/gi, agentName)
    .replace(/\[nomeagente\]/gi, agentName);

  // Estrai firstMessage
  let firstMessage = null;
  const m = effectivePrompt.match(/APERTURA[:\s]+[""]?([^\n"]{10,200})[""]?/i);
  if (m) firstMessage = m[1].trim();

  // Chiama ElevenLabs
  try {
    const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(ELEVENLABS_AGENT_ID)}&include_conversation_id=true`;

    const elRes = await fetch(url, {
      method: 'GET',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(8000)
    });

    if (!elRes.ok) {
      const errText = await elRes.text().catch(() => '');
      throw new Error(`ElevenLabs ${elRes.status}: ${errText.slice(0, 200)}`);
    }

    const payload   = await elRes.json();
    const signedUrl = String(payload?.signed_url || '').trim();
    const convId    = String(payload?.conversation_id || payload?.conversationId || '').trim();

    if (!signedUrl) throw new Error('signed_url mancante nella risposta ElevenLabs');

    console.log(`[session] ip=${getClientIP(req)} conv=${convId || '-'} user="${userName}" daily=${dailySessions}/${MAX_DAILY_SESSIONS}`);

    return res.json({
      signedUrl,
      conversationId: convId || null,
      effectivePrompt,
      firstMessage,
      voiceTuning: { tts: { speed: 1.0, stability: 0.5, similarityBoost: 0.75 } },
      agentName, userName, company
    });

  } catch (err) {
    console.error('[session] Errore:', err.message);
    return res.status(502).json({ error: 'Errore temporaneo. Riprova tra qualche secondo.' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/voice-demo/health', (req, res) => {
  res.json({
    ok: true,
    hasApiKey:  Boolean(ELEVENLABS_API_KEY),
    hasAgentId: Boolean(ELEVENLABS_AGENT_ID),
    daily: { used: dailySessions, max: MAX_DAILY_SESSIONS }
  });
});

// ── 404 e error handler ───────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err.message);
  res.status(500).json({ error: 'Errore interno.' });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n  🎙️  ATS Voice Demo  [HARDENED]\n');
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log(`  CORS origins:   ${ALLOWED_ORIGINS.join(' | ')}`);
  console.log(`  Rate limit:     3 sessioni/IP ogni 10min  ·  30 globali/min`);
  console.log(`  Budget daily:   ${MAX_DAILY_SESSIONS} sessioni`);
  console.log(`  Demo token:     ${DEMO_SECRET ? '🔒 attivo' : '⚪ disabilitato (imposta DEMO_SECRET per abilitarlo)'}`);
  console.log(`  Blocklist:      ${PERMANENT_BLOCK.size} IP permanenti`);
  if (!ELEVENLABS_API_KEY)  console.warn('\n  ⚠️  ELEVENLABS_API_KEY mancante!');
  if (!ELEVENLABS_AGENT_ID) console.warn('  ⚠️  ELEVENLABS_AGENT_ID mancante!');
  if (ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID) console.log('\n  ✅  ElevenLabs configurato');
  console.log('');
});
