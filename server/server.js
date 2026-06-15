// ─────────────────────────────────────────────────────────────────────────────
// XR Stage — LiveKit token server
//
// A tiny, stateless Node/Express service whose only job is to mint short-lived
// LiveKit access tokens for the spatial-stage client. It holds the LiveKit API
// key + secret (from env — NEVER in the repo) and the browser never sees them:
// the client POSTs { room, identity, role } and gets back a signed JWT whose
// grants match the role.
//
// Endpoints:
//   GET  /health   → { ok: true }
//   POST /token    → { token, identity, role, room }   (see token.js)
//
// Deploys to Railway (start: `node server.js`; Railway injects PORT). CORS is
// locked to the client origin(s) via ALLOWED_ORIGIN.
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import cors from 'cors';
import { tokenHandler } from './token.js';

// ── Config (all from env) ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;

// Comma-separated list of allowed browser origins. In dev, add your Vite origin
// (https://localhost:5173). In prod, set this to your GitHub Pages origin.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors({
  origin(origin, cb) {
    // Allow non-browser callers (curl, native clients) which send no Origin.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
}));

app.get('/', (_req, res) => res.type('text').send('XR Stage token server — ok'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// POST /token { room, identity, role } → { token, identity, role, room }
app.post('/token', tokenHandler);

app.listen(PORT, () => console.log(`XR Stage token server listening on :${PORT}`));
