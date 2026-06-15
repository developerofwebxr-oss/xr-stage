// ─────────────────────────────────────────────────────────────────────────────
// server/token.js — mints LiveKit access tokens for the spatial-stage client.
//
// The LiveKit API key + secret live ONLY here (from env); the browser never sees
// them. The client POSTs { room, identity, role } and gets back a short-lived JWT
// whose grants match the role: a `speaker` may publish audio; a `listener` may
// not. Everyone may subscribe and use the data channel (presence + future shared
// state like "who holds the stage", zaps, sponsor slots).
//
// Role here is trust-on-request FOR NOW — the client just asks. Real gating
// (Lightning slot booking) lands in a later prompt and belongs right here, deciding
// whether to grant `speaker` before the token is signed.
//
// Exposes one express handler: tokenHandler. Mounted at POST /token in server.js.
// ─────────────────────────────────────────────────────────────────────────────

import { AccessToken } from 'livekit-server-sdk';

const API_KEY    = process.env.LIVEKIT_API_KEY || '';
const API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const TOKEN_TTL  = process.env.LIVEKIT_TOKEN_TTL || '2h';

if (!API_KEY || !API_SECRET) {
  console.warn('⚠  LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set — /token will 500 until they are.');
}

// Conservative validation so a malformed/hostile body can't create absurd
// identities or room names. Letters, digits, and a few safe punctuation marks.
const isCleanString = (v, max) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && /^[\w .:@-]+$/.test(v);

export async function tokenHandler(req, res) {
  if (!API_KEY || !API_SECRET) {
    return res.status(500).json({ error: 'LiveKit credentials not configured on server' });
  }

  const { room, identity } = req.body || {};
  // Anything other than the explicit 'speaker' string is a listener — fail closed.
  const role = req.body && req.body.role === 'speaker' ? 'speaker' : 'listener';

  if (!isCleanString(room, 64) || !isCleanString(identity, 64)) {
    return res.status(400).json({ error: 'room and identity are required strings (≤64 chars, [\\w .:@-])' });
  }

  try {
    const at = new AccessToken(API_KEY, API_SECRET, { identity, ttl: TOKEN_TTL });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: role === 'speaker', // listeners cannot publish audio
      canSubscribe: true,             // everyone hears the room
      canPublishData: true,           // everyone can send presence / shared state
    });

    // v2 toJwt() is async.
    const token = await at.toJwt();
    res.json({ token, identity, role, room });
  } catch (err) {
    console.error('token mint error', err.message);
    res.status(500).json({ error: 'failed to mint token' });
  }
}
