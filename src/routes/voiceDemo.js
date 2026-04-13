/**
 * src/routes/voiceDemo.js
 *
 * Tutte le route /api/voice-demo/*
 *
 *  POST /api/voice-demo/session   → crea sessione ElevenLabs
 *  GET  /api/voice-demo/health    → health check
 */

import { Router } from 'express';
import {
  ipGuard,
  demoToken,
  sessionRateLimit,
  globalRateLimit,
  getClientIP,
  logAbuse,
} from '../middleware/security.js';
import { sanitizeVoiceDemoBody, honeypot } from '../middleware/sanitize.js';

const router = Router();

// ── Config ElevenLabs ─────────────────────────────────────────────────────────
const ELEVENLABS_API_KEY  = () => process.env.ELEVENLABS_API_KEY  || '';
const ELEVENLABS_AGENT_ID = () => process.env.ELEVENLABS_AGENT_ID || '';

// ── Budget giornaliero ────────────────────────────────────────────────────────
const MAX_DAILY = () => Number(process.env.MAX_DAILY_SESSIONS || 200);
let dailySessions = 0;
let dailyResetDate = new Date().toDateString();

function checkBudget() {
  const today = new Date().toDateString();
  if (today !== dailyResetDate) { dailySessions = 0; dailyResetDate = today; }
  if (dailySessions >= MAX_DAILY()) return false;
  dailySessions++;
  return true;
}

// ── Helper: estrai primo messaggio dal prompt ─────────────────────────────────
function extractFirstMessage(prompt) {
  const m = prompt.match(/APERTURA[:\s]+[""]?([^\n"]{10,300})[""]?/i);
  return m ? m[1].trim() : null;
}

// ── POST /api/voice-demo/session ──────────────────────────────────────────────
router.post(
  '/session',
  ipGuard,
  demoToken,
  globalRateLimit,
  sessionRateLimit,
  honeypot,
  async (req, res) => {

    const apiKey  = ELEVENLABS_API_KEY();
    const agentId = ELEVENLABS_AGENT_ID();

    if (!apiKey || !agentId) {
      return res.status(503).json({ error: 'Servizio vocale non configurato. Contatta l\'amministratore.' });
    }

    if (!checkBudget()) {
      logAbuse('__budget__', `Cap giornaliero raggiunto: ${MAX_DAILY()}`);
      return res.status(503).json({
        error: `Limite giornaliero di ${MAX_DAILY()} demo raggiunto. Riprova domani!`
      });
    }

    // Sanitizzazione
    const { promptDraft, agentName, userName, company } = sanitizeVoiceDemoBody(req.body);

    if (!promptDraft) {
      return res.status(400).json({ error: 'Prompt mancante o non valido.' });
    }

    // Iniezione nome agente
    const effectivePrompt = promptDraft
      .replace(/\[nome\]/gi, agentName)
      .replace(/\[nomeagente\]/gi, agentName);

    const firstMessage = extractFirstMessage(effectivePrompt);

    // Chiamata ElevenLabs
    try {
      const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url` +
        `?agent_id=${encodeURIComponent(agentId)}&include_conversation_id=true`;

      const elRes = await fetch(url, {
        method: 'GET',
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(8_000),
      });

      if (!elRes.ok) {
        const errText = await elRes.text().catch(() => '');
        throw new Error(`ElevenLabs ${elRes.status}: ${errText.slice(0, 200)}`);
      }

      const payload   = await elRes.json();
      const signedUrl = String(payload?.signed_url || '').trim();
      const convId    = String(payload?.conversation_id || payload?.conversationId || '').trim();

      if (!signedUrl) throw new Error('signed_url mancante nella risposta ElevenLabs');

      console.log(
        `[voice-demo] ip=${getClientIP(req)} conv=${convId || '-'}` +
        ` user="${userName}" daily=${dailySessions}/${MAX_DAILY()}`
      );

      return res.json({
        signedUrl,
        conversationId : convId || null,
        effectivePrompt,
        firstMessage,
        voiceTuning    : { tts: { speed: 1.0, stability: 0.5, similarityBoost: 0.75 } },
        agentName, userName, company,
      });

    } catch (err) {
      console.error('[voice-demo] Errore sessione:', err.message);
      // Non esporre dettagli interni al client
      return res.status(502).json({ error: 'Errore temporaneo. Riprova tra qualche secondo.' });
    }
  }
);

// ── GET /api/voice-demo/health ────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({
    ok       : true,
    hasApiKey : Boolean(ELEVENLABS_API_KEY()),
    hasAgentId: Boolean(ELEVENLABS_AGENT_ID()),
    daily    : { used: dailySessions, max: MAX_DAILY() },
  });
});

export default router;
