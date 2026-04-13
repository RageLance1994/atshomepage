/**
 * src/server.js
 *
 * Entrypoint: carica .env, crea l'app e avvia il server HTTP.
 *
 *   npm start          → produzione
 *   npm run dev        → sviluppo con auto-reload (node --watch)
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Carica .env (senza dotenv come dipendenza) ────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath   = path.resolve(__dirname, '../.env');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t  = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}

// ── Crea e avvia l'app ────────────────────────────────────────────────────────
import { createApp } from './app.js';
import { ALLOWED_ORIGINS } from './middleware/security.js';

const PORT = Number(process.env.PORT || 3000);
const app  = createApp();

const server = app.listen(PORT, () => {
  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, DEMO_SECRET, MAX_DAILY_SESSIONS } = process.env;

  console.log('\n  🚀  ATS — Automated Technology Solutions\n');
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log(`  📁  Sito:     http://localhost:${PORT}/`);
  console.log(`  🎙️  Demo:     http://localhost:${PORT}/demo`);
  console.log(`  🩺  Health:   http://localhost:${PORT}/api/voice-demo/health`);
  console.log('');
  console.log(`  CORS:         ${ALLOWED_ORIGINS.join(' | ')}`);
  console.log(`  Rate limit:   3 sessioni/IP·10min  |  30 globali/min`);
  console.log(`  Budget:       ${MAX_DAILY_SESSIONS || 200} sessioni/giorno`);
  console.log(`  Demo token:   ${DEMO_SECRET ? '🔒 attivo' : '⚪ disabilitato'}`);
  console.log('');
  if (!ELEVENLABS_API_KEY)  console.warn('  ⚠️  ELEVENLABS_API_KEY mancante!');
  if (!ELEVENLABS_AGENT_ID) console.warn('  ⚠️  ELEVENLABS_AGENT_ID mancante!');
  if (ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID) {
    console.log('  ✅  ElevenLabs configurato');
  }
  console.log('');
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n  [${signal}] Spegnimento graceful...`);
  server.close(() => {
    console.log('  Server chiuso. Ciao! 👋\n');
    process.exit(0);
  });
  // Forza uscita se non chiude in 5s
  setTimeout(() => process.exit(1), 5_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
