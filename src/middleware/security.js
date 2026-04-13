/**
 * src/middleware/security.js
 *
 * Tutto il layer di sicurezza in un unico posto:
 *  - Security headers
 *  - CORS whitelist
 *  - IP blocklist (permanente + auto-ban temporaneo)
 *  - Rate limiter sliding-window (per-IP + globale)
 *  - Demo token opzionale
 *  - Abuse logging
 */

import { existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '../../logs');
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// ── Config da env ─────────────────────────────────────────────────────────────
export const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  'http://localhost:3000,https://atsco.it,https://www.atsco.it'
).split(',').map(o => o.trim()).filter(Boolean);

export const DEMO_SECRET = process.env.DEMO_SECRET || '';

const PERMANENT_BLOCK = new Set(
  (process.env.BLOCKED_IPS || '').split(',').map(i => i.trim()).filter(Boolean)
);

// ── Costanti anti-abuse ───────────────────────────────────────────────────────
const ABUSE_THRESHOLD = 10;           // hit in finestra prima del ban
const ABUSE_WINDOW_MS = 60_000;       // finestra: 1 minuto
const TEMP_BLOCK_MS   = 30 * 60_000; // blocco temporaneo: 30 minuti

// ── Strutture in-memory ───────────────────────────────────────────────────────
const abuseTracker   = new Map();  // ip → { hits, firstHit }
const tempBlock      = new Map();  // ip → timestamp fine blocco
const rateLimitStore = new Map();  // key → [timestamps...]

// ── Helpers ───────────────────────────────────────────────────────────────────
export function getClientIP(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

export function logAbuse(ip, reason, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ip, reason, ...extra }) + '\n';
  try { writeFileSync(path.join(LOG_DIR, 'abuse.log'), line, { flag: 'a' }); } catch (_) {}
  console.warn(`[ABUSE] ${ip} — ${reason}`);
}

function isBlocked(ip) {
  if (PERMANENT_BLOCK.has(ip)) return 'permanent';
  const until = tempBlock.get(ip);
  if (until) {
    if (Date.now() < until) return 'temporary';
    tempBlock.delete(ip);
  }
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
    logAbuse(ip, `Auto-ban: ${ABUSE_THRESHOLD} hit in ${ABUSE_WINDOW_MS / 1000}s`);
    return true;
  }
  return false;
}

// ── Rate limit factory (sliding window) ──────────────────────────────────────
export function rateLimit({ windowMs, max, keyFn = (r) => getClientIP(r) }) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const hits = (rateLimitStore.get(key) || []).filter(t => now - t < windowMs);
    hits.push(now);
    rateLimitStore.set(key, hits);
    if (hits.length > max) {
      logAbuse(key, `Rate limit: ${hits.length}/${max} in ${windowMs / 1000}s`);
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({
        error: 'Troppe richieste. Riprova tra qualche minuto.',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }
    next();
  };
}

// ── Middleware: security headers ──────────────────────────────────────────────
export function securityHeaders(req, res, next) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=self');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// ── Middleware: CORS ──────────────────────────────────────────────────────────
export function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Demo-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// ── Middleware: IP block + abuse tracking (per le rotte /api) ─────────────────
export function ipGuard(req, res, next) {
  const ip = getClientIP(req);
  const blocked = isBlocked(ip);
  if (blocked === 'permanent') {
    logAbuse(ip, 'Blocklist permanente');
    return res.status(403).json({ error: 'Accesso negato.' });
  }
  if (blocked === 'temporary') {
    return res.status(429).json({ error: 'IP bloccato temporaneamente. Riprova tra 30 minuti.' });
  }
  if (trackAbuse(ip)) {
    return res.status(429).json({ error: 'Troppe richieste. IP bloccato per 30 minuti.' });
  }
  next();
}

// ── Middleware: demo token opzionale ──────────────────────────────────────────
export function demoToken(req, res, next) {
  if (!DEMO_SECRET) return next();
  const provided = String(req.headers['x-demo-token'] || '');
  const safe = (a, b) => {
    const pa = Buffer.from(a.padEnd(64).slice(0, 64));
    const pb = Buffer.from(b.padEnd(64).slice(0, 64));
    return crypto.timingSafeEqual(pa, pb);
  };
  if (!safe(provided, DEMO_SECRET)) {
    logAbuse(getClientIP(req), 'Token non valido');
    return res.status(401).json({ error: 'Token non valido.' });
  }
  next();
}

// ── Rate limit istanze pronte per le route ────────────────────────────────────
// 3 sessioni ElevenLabs per IP ogni 10 minuti
export const sessionRateLimit = rateLimit({ windowMs: 10 * 60_000, max: 3 });
// 30 sessioni globali al minuto (DDoS)
export const globalRateLimit  = rateLimit({ windowMs: 60_000, max: 30, keyFn: () => '__global__' });
