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

    // Chiamata ElevenLabs ── signed URL
    try {
      // Nota: include_conversation_id NON è un param valido → rimosso
      const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url` +
        `?agent_id=${encodeURIComponent(agentId)}`;

      const elRes = await fetch(url, {
        method: 'GET',
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(10_000),
      });

      if (!elRes.ok) {
        const errBody = await elRes.text().catch(() => '');
        const detail  = errBody.slice(0, 300);
        console.error(
          `[voice-demo] ElevenLabs error: HTTP ${elRes.status}` +
          ` agent=${agentId.slice(0,8)}… body=${detail}`
        );
        // In sviluppo esponi il dettaglio, in produzione messaggio generico
        const isDev = process.env.NODE_ENV !== 'production';
        return res.status(502).json({
          error: isDev
            ? `ElevenLabs ${elRes.status}: ${detail}`
            : 'Servizio vocale temporaneamente non disponibile. Riprova tra qualche secondo.',
          code: `EL_${elRes.status}`,
        });
      }

      const payload   = await elRes.json();
      const signedUrl = String(payload?.signed_url || '').trim();

      if (!signedUrl) {
        console.error('[voice-demo] signed_url assente in risposta EL:', JSON.stringify(payload));
        throw new Error('signed_url assente nella risposta ElevenLabs');
      }

      console.log(
        `[voice-demo] ✓ sessione creata` +
        ` ip=${getClientIP(req)} user="${userName}" daily=${dailySessions}/${MAX_DAILY()}`
      );

      return res.json({
        signedUrl,
        conversationId : null, // viene assegnato da EL al momento della connessione WS
        effectivePrompt,
        firstMessage,
        voiceTuning    : { tts: { speed: 1.0, stability: 0.5, similarityBoost: 0.75 } },
        agentName, userName, company,
      });

    } catch (err) {
      const isDev = process.env.NODE_ENV !== 'production';
      console.error('[voice-demo] Errore sessione:', err.message);
      return res.status(502).json({
        error: isDev
          ? `Errore interno: ${err.message}`
          : 'Errore temporaneo. Riprova tra qualche secondo.',
        code: 'SESSION_ERROR',
      });
    }
  }
);

// ── GET /api/voice-demo/health ────────────────────────────────────────────────
router.get('/health', (req, res) => {
  const apiKey  = ELEVENLABS_API_KEY();
  const agentId = ELEVENLABS_AGENT_ID();
  const ok = Boolean(apiKey) && Boolean(agentId);
  res.status(ok ? 200 : 503).json({
    ok,
    config: {
      hasApiKey  : Boolean(apiKey),
      apiKeyHint : apiKey  ? `${apiKey.slice(0,4)}…${apiKey.slice(-4)}`  : null,
      hasAgentId : Boolean(agentId),
      agentIdHint: agentId ? `${agentId.slice(0,6)}…` : null,
    },
    daily : { used: dailySessions, max: MAX_DAILY() },
    node  : process.version,
    env   : process.env.NODE_ENV || 'development',
  });
});

export default router;
