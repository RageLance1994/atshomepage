/**
 * ATS Voice Demo — Backend Server
 *
 * Avvio:
 *   ELEVENLABS_API_KEY=sk-... ELEVENLABS_AGENT_ID=agent_... node voice-demo-server.js
 *
 * Oppure crea un file .env con:
 *   ELEVENLABS_API_KEY=sk-...
 *   ELEVENLABS_AGENT_ID=agent_...
 *   PORT=3000
 *
 * Poi:
 *   node voice-demo-server.js
 */

import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, existsSync } from 'fs';

// ── Carica .env manualmente (senza dotenv come dipendenza) ──────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

const app = express();
app.use(express.json());

const ELEVENLABS_API_KEY   = process.env.ELEVENLABS_API_KEY   || '';
const ELEVENLABS_AGENT_ID  = process.env.ELEVENLABS_AGENT_ID  || '';
const PORT                 = Number(process.env.PORT || 3000);

// ── Serve voice-demo.html ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  const file = path.join(__dirname, 'voice-demo.html');
  if (existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).send('voice-demo.html non trovato nella stessa cartella.');
  }
});

// ── POST /api/voice-demo/session ────────────────────────────────────────────
// Body: { promptDraft, agentName, userName, company }
// Returns: { signedUrl, conversationId, effectivePrompt, firstMessage, voiceTuning }
app.post('/api/voice-demo/session', async (req, res) => {
  if (!ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY non configurata. Vedi README nel file.' });
  }
  if (!ELEVENLABS_AGENT_ID) {
    return res.status(500).json({ error: 'ELEVENLABS_AGENT_ID non configurato. Vedi README nel file.' });
  }

  try {
    const promptDraft = String(req.body?.promptDraft || '').trim();
    const agentName   = String(req.body?.agentName   || 'Alex').trim();
    const userName    = String(req.body?.userName    || '').trim();
    const company     = String(req.body?.company     || '').trim();

    // Costruisci il prompt finale iniettando il nome agente
    const effectivePrompt = promptDraft
      .replace(/\[nome\]/gi, agentName)
      .replace(/\[nomeagente\]/gi, agentName);

    // Estrai il firstMessage dal prompt (la riga "APERTURA:")
    let firstMessage = null;
    const aperturaMatch = effectivePrompt.match(/APERTURA[:\s]+[""]?([^\n"]+)[""]?/i);
    if (aperturaMatch) firstMessage = aperturaMatch[1].trim();

    // Ottieni il signed URL da ElevenLabs
    const signedUrlEndpoint =
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(ELEVENLABS_AGENT_ID)}&include_conversation_id=true`;

    const signedUrlRes = await fetch(signedUrlEndpoint, {
      method: 'GET',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY }
    });

    if (!signedUrlRes.ok) {
      const errText = await signedUrlRes.text();
      throw new Error(`ElevenLabs error ${signedUrlRes.status}: ${errText}`);
    }

    const payload = await signedUrlRes.json();
    const signedUrl      = String(payload?.signed_url || '').trim();
    const conversationId = String(payload?.conversation_id || payload?.conversationId || '').trim();

    if (!signedUrl) throw new Error('ElevenLabs non ha restituito un signed_url');

    return res.json({
      signedUrl,
      conversationId: conversationId || null,
      effectivePrompt,
      firstMessage,
      voiceTuning: {
        tts: {
          speed: 1.0,
          stability: 0.5,
          similarityBoost: 0.75
        }
      },
      agentName,
      userName,
      company
    });

  } catch (err) {
    console.error('[voice-demo] Session error:', err.message);
    return res.status(500).json({ error: err.message || 'Errore interno' });
  }
});

// ── Health check ────────────────────────────────────────────────────────────
app.get('/api/voice-demo/health', (req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(ELEVENLABS_API_KEY),
    hasAgentId: Boolean(ELEVENLABS_AGENT_ID)
  });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  🎙️  ATS Voice Demo Server');
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log('');
  if (!ELEVENLABS_API_KEY)  console.warn('  ⚠️  ELEVENLABS_API_KEY mancante!');
  if (!ELEVENLABS_AGENT_ID) console.warn('  ⚠️  ELEVENLABS_AGENT_ID mancante!');
  if (ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID) console.log('  ✅  ElevenLabs configurato');
  console.log('');
});
