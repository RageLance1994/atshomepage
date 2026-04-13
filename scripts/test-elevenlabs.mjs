/**
 * scripts/test-elevenlabs.mjs
 *
 * Script di diagnosi per le credenziali ElevenLabs.
 * Esegui con:  node scripts/test-elevenlabs.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Carica .env manualmente ───────────────────────────────────────────────────
function loadEnv() {
  const envPath = resolve(__dir, '..', '.env');
  try {
    const raw = readFileSync(envPath, 'utf-8');
    const env = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      env[key] = val;
    }
    return env;
  } catch {
    console.error('❌  .env non trovato in:', envPath);
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const env = loadEnv();
const API_KEY  = env.ELEVENLABS_API_KEY  || '';
const AGENT_ID = env.ELEVENLABS_AGENT_ID || '';

console.log('\n─── ElevenLabs Diagnostic ───────────────────────────────────');
console.log(`  Node version  : ${process.version}`);
console.log(`  API Key       : ${API_KEY  ? `${API_KEY.slice(0,4)}…${API_KEY.slice(-4)} (${API_KEY.length} chars)` : '❌ MANCANTE'}`);
console.log(`  Agent ID      : ${AGENT_ID ? `${AGENT_ID.slice(0,8)}… (${AGENT_ID.length} chars)` : '❌ MANCANTE'}`);
console.log('─────────────────────────────────────────────────────────────');

if (!API_KEY || !AGENT_ID) {
  console.error('\n❌  Credenziali mancanti nel .env — impossibile procedere.\n');
  process.exit(1);
}

// Test 1: verifica account ElevenLabs
console.log('\n[1/2] Verifica API key → GET /v1/user ...');
try {
  const r1 = await fetch('https://api.elevenlabs.io/v1/user', {
    headers: { 'xi-api-key': API_KEY },
    signal: AbortSignal.timeout(8_000),
  });
  const body1 = await r1.json().catch(() => null);
  if (r1.ok) {
    console.log(`  ✅  API key valida — account: ${body1?.first_name || body1?.email || '(nessun nome)'}`);
    if (body1?.subscription?.tier) {
      console.log(`  Subscription: ${body1.subscription.tier}`);
    }
  } else {
    console.error(`  ❌  HTTP ${r1.status}: ${JSON.stringify(body1)}`);
    console.error('  → Controlla che la API key sia quella di ElevenLabs (Settings → API Key)');
    process.exit(1);
  }
} catch (e) {
  console.error('  ❌  Errore di rete:', e.message);
  process.exit(1);
}

// Test 2: richiedi signed URL per l'agente
console.log(`\n[2/2] Richiedi signed URL → GET /v1/convai/conversation/get-signed-url?agent_id=${AGENT_ID.slice(0,8)}… ...`);
try {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(AGENT_ID)}`;
  const r2 = await fetch(url, {
    headers: { 'xi-api-key': API_KEY },
    signal: AbortSignal.timeout(10_000),
  });
  const body2 = await r2.json().catch(() => null);

  if (r2.ok && body2?.signed_url) {
    const su = String(body2.signed_url);
    console.log(`  ✅  Signed URL ricevuto: ${su.slice(0, 60)}…`);
    console.log('\n✨  Tutto OK — le credenziali funzionano. Il backend dovrebbe funzionare.\n');
  } else {
    console.error(`  ❌  HTTP ${r2.status}:`);
    console.error('  Risposta:', JSON.stringify(body2, null, 2));
    console.error('\n  Cause possibili:');
    if (r2.status === 401 || r2.status === 403) {
      console.error('  → API key non ha permessi ConvAI (verifica il piano ElevenLabs)');
    } else if (r2.status === 404) {
      console.error('  → AGENT_ID non trovato: verifica che l\'ID sia corretto nella dashboard ElevenLabs → ConvAI');
      console.error(`  → Hai usato: "${AGENT_ID}"`);
    } else if (r2.status === 422) {
      console.error('  → Parametri non validi — potrebbe essere un formato agent_id sbagliato');
    }
    process.exit(1);
  }
} catch (e) {
  console.error('  ❌  Errore di rete:', e.message);
  process.exit(1);
}
