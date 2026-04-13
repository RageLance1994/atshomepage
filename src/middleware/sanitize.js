/**
 * src/middleware/sanitize.js
 *
 * Sanitizzazione input e difesa prompt-injection.
 * Importabile sia come middleware Express che come funzione pura.
 */

import { logAbuse, getClientIP } from './security.js';

// ── Pattern prompt-injection ──────────────────────────────────────────────────
// Coprono i vettori classici: jailbreak, system override, esfiltrazione, DAN mode
const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+(instructions?|prompts?|context)/gi,
  /you\s+are\s+now\s+(a\s+)?/gi,
  /\bsystem\s*:\s*/gi,
  /\[INST\]/gi,
  /<<SYS>>/gi,
  /<\|im_start\|>/gi,
  /forget\s+(everything|all|your\s+instructions)/gi,
  /act\s+as\s+(if\s+you\s+are|a\s+different|an?\s+)/gi,
  /\bjailbreak\b/gi,
  /\bDAN\s+mode\b/gi,
  /pretend\s+(you\s+are|to\s+be)/gi,
  /override\s+(your\s+)?(system|instructions?|prompt)/gi,
  /send\s+.*?\s+(api[\s_-]?key|secret|password|token)/gi,
  /reveal\s+.*?\s+(api[\s_-]?key|secret|password)/gi,
  /\bexfiltrat/gi,
  /\bdisregard\b.*\binstructions?\b/gi,
];

// ── Sanitizza una stringa ─────────────────────────────────────────────────────
export function sanitizeText(input, maxLen = 500, context = 'unknown') {
  if (typeof input !== 'string') return '';

  let text = input
    .slice(0, maxLen)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')  // control chars pericolosi
    .replace(/<[^>]{0,200}>/g, '')                        // HTML tags (bounded)
    .trim();

  // Reset regex lastIndex prima di testare (per i flag /g)
  for (const pat of INJECTION_PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) {
      logAbuse('input-sanitize', `Prompt injection: pattern ${pat.source.slice(0, 40)}`, {
        context,
        snippet: text.slice(0, 120)
      });
      return '[contenuto rimosso]';
    }
  }

  return text;
}

// ── Sanitizza tutto il body della richiesta voice-demo ───────────────────────
export function sanitizeVoiceDemoBody(body) {
  return {
    promptDraft : sanitizeText(String(body?.promptDraft  || ''), 3000, 'promptDraft'),
    agentName   : sanitizeText(String(body?.agentName    || 'Alex'), 40, 'agentName'),
    userName    : sanitizeText(String(body?.userName     || ''),     80, 'userName'),
    company     : sanitizeText(String(body?.company      || ''),     80, 'company'),
  };
}

// ── Middleware: honeypot anti-bot ─────────────────────────────────────────────
// Il frontend non manda mai questi campi; un bot che riempie tutto i form li manda.
export function honeypot(req, res, next) {
  if (req.body?.website || req.body?._gotcha || req.body?.email_confirm) {
    logAbuse(getClientIP(req), 'Honeypot triggered', { fields: Object.keys(req.body) });
    return res.status(400).json({ error: 'Richiesta non valida.' });
  }
  next();
}
