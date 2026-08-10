// ─────────────────────────────────────────────────────────────────────────────
// server/session.js — cross-device "log in on your headset" pairing.
//
// A signed-in phone/desktop mints a short numeric CODE bound to its PUBLIC identity
// profile; the headset (or any device) redeems the code and adopts that identity, so
// it can zap/post/queue as the same person (balance follows via the client's per-pubkey
// persistence). This is the code-and-redeem pairing pattern, pointed at LOGIN.
//
//   POST /session-code    { pubkey, name, picture?, nip05?, lud16? } → { code, expiresAt }
//   POST /session-redeem  { code }  → { pubkey, name, picture?, nip05?, lud16? } | 400/404/410/429
//
// SECURITY MODEL (matches the arcade wallet):
//   • The payload is the PUBLIC identity profile ONLY — pubkey + display fields. No
//     nsec / private key / secret is ever accepted or stored. (Real NIP-07 signing stays
//     on the original device; the headset session is a reader/spender of the venue
//     balance.) Unknown body fields are dropped.
//   • Codes are 6 digits, single-use (deleted on first successful redeem), TTL ~5 min,
//     expired entries purged. Guessing is bounded by a per-IP redeem rate limit.
//   • In-memory only (no DB) — a restart drops outstanding codes, which is fine: they're
//     short-lived pairing tokens, not accounts.
// ─────────────────────────────────────────────────────────────────────────────

import { randomInt } from 'node:crypto';

const TTL_MS = Number(process.env.SESSION_TTL_MS) || 5 * 60 * 1000; // codes live ~5 minutes (overridable for tests)
const REDEEM_LIMIT = 10;              // max redeem attempts…
const REDEEM_WINDOW_MS = 60 * 1000;   // …per IP per minute (brute-force bound)

const codes = new Map();      // code(6-digit string) → { payload, expiresAt }
const redeemHits = new Map(); // ip → number[] (redeem timestamps within the window)

const HEX64 = /^[0-9a-f]{64}$/i;
// Display fields: word chars + a few safe punctuation marks (names, nip05/lud16 handles).
const isCleanString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[\w .:@-]+$/.test(v);
const cleanField = (v, max) => (isCleanString(v, max) ? v : undefined);
// picture is a URL — allow the URL charset (https only), else drop it.
const cleanPicture = (v) => (typeof v === 'string' && v.length <= 512 && /^https:\/\/[\w.\-/:%?#=&]+$/i.test(v) ? v : undefined);

function purge(now = Date.now()) {
  for (const [code, e] of codes) if (e.expiresAt <= now) codes.delete(code);
  for (const [ip, hits] of redeemHits) {
    const live = hits.filter((t) => now - t < REDEEM_WINDOW_MS);
    if (live.length) redeemHits.set(ip, live); else redeemHits.delete(ip);
  }
}
// Light periodic sweep so nothing accumulates on a long-lived server (does not keep the
// process alive on its own).
setInterval(() => purge(), REDEEM_WINDOW_MS).unref?.();

function newCode() {
  for (let i = 0; i < 25; i++) {                             // retry on the rare live-code collision
    const c = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (!codes.has(c)) return c;
  }
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// POST /session-code — mint a code for the caller's PUBLIC profile.
export function sessionCodeHandler(req, res) {
  const now = Date.now();
  purge(now);
  const b = req.body || {};
  if (!HEX64.test(b.pubkey || '') || !isCleanString(b.name, 48)) {
    return res.status(400).json({ error: 'pubkey (64-hex) and name are required' });
  }
  // PUBLIC identity only — build the payload from KNOWN fields, dropping anything else.
  const payload = { pubkey: String(b.pubkey).toLowerCase(), name: b.name };
  const picture = cleanPicture(b.picture); if (picture) payload.picture = picture;
  const nip05 = cleanField(b.nip05, 64);   if (nip05) payload.nip05 = nip05;
  const lud16 = cleanField(b.lud16, 64);   if (lud16) payload.lud16 = lud16;

  const code = newCode();
  const expiresAt = now + TTL_MS;
  codes.set(code, { payload, expiresAt });
  res.json({ code, expiresAt });
}

// POST /session-redeem — trade a code for the stored profile (one-time, rate-limited).
export function sessionRedeemHandler(req, res) {
  const now = Date.now();
  // NB: don't purge the store here — a just-expired code should still resolve to 410
  // (existed-but-expired), not 404. The periodic sweep + the delete-below handle cleanup.

  // Per-IP rate limit (needs `trust proxy` so req.ip is the real client behind Railway).
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const hits = (redeemHits.get(ip) || []).filter((t) => now - t < REDEEM_WINDOW_MS);
  if (hits.length >= REDEEM_LIMIT) return res.status(429).json({ error: 'too many attempts — slow down' });
  hits.push(now);
  redeemHits.set(ip, hits);

  const code = String((req.body && req.body.code) || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'code must be 6 digits' });

  const entry = codes.get(code);
  if (!entry) return res.status(404).json({ error: 'code invalid or expired' });
  if (entry.expiresAt <= now) { codes.delete(code); return res.status(410).json({ error: 'code expired' }); }

  codes.delete(code);                 // one-time: consumed on first success
  res.json(entry.payload);
}
