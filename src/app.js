/**
 * src/app.js
 *
 * Factory dell'applicazione Express.
 * Separato da server.js per facilitare i test.
 */

import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';

import { securityHeaders, cors } from './middleware/security.js';
import voiceDemoRouter from './routes/voiceDemo.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

export function createApp() {
  const app = express();

  // ── Parsing body ────────────────────────────────────────────────────────────
  app.use(express.json({ limit: '8kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));

  // ── Security & CORS (su tutte le route) ────────────────────────────────────
  app.use(securityHeaders);
  app.use(cors);

  // ── Static files ───────────────────────────────────────────────────────────
  // Serve public/ → homepage, assets, ecc.
  app.use(express.static(PUBLIC_DIR, {
    // Non esporre la directory listing
    index: 'index.html',
    // Cache aggressiva per asset statici (1 ora)
    maxAge: '1h',
    // HTML: no-cache (cambiano più spesso)
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  // ── Rotta esplicita /demo ──────────────────────────────────────────────────
  // Necessaria se il client naviga direttamente /demo senza trailing slash
  app.get('/demo', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'demo', 'index.html'));
  });

  // ── API routes ─────────────────────────────────────────────────────────────
  app.use('/api/voice-demo', voiceDemoRouter);

  // ── SPA fallback (opzionale, da abilitare se aggiungi frontend React/Vue) ──
  // app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // ── 404 ────────────────────────────────────────────────────────────────────
  app.use((req, res) => {
    // Se è una richiesta API → JSON
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Endpoint non trovato.' });
    }
    // Altrimenti → 404 HTML semplice
    res.status(404).send('<h1>404 — Pagina non trovata</h1>');
  });

  // ── Error handler globale ──────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error('[error]', err?.message || err);
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ error: 'Errore interno del server.' });
    }
    res.status(500).send('<h1>500 — Errore interno</h1>');
  });

  return app;
}
