// config.js — read-only runtime config, resolved once from env + URL.
//
// Keeps the "where do I connect" knobs in one place so modules don't each parse
// import.meta.env / location.search. Nothing here is a secret: the LiveKit URL is
// public and the token endpoint hands out short-lived JWTs minted server-side.

const params = new URLSearchParams(location.search);

export const config = {
  // LiveKit SFU websocket URL (LiveKit Cloud or a self-host — same code path).
  // Used exactly as provided; blank is surfaced as a setup error at join time.
  livekitUrl: (import.meta.env.VITE_LIVEKIT_URL || '').trim(),

  // The FULL token endpoint URL (scheme and path), e.g.
  //   https://xr-stage-production.up.railway.app/token
  // It is fetched exactly as given — the voice layer does NOT append "/token" (that
  // caused a /token/token 404). No silent localhost fallback: blank → clear error.
  tokenUrl: (import.meta.env.VITE_TOKEN_URL || '').trim(),

  // Which stage room to join. Lets several independent rooms share one deployment.
  room: params.get('room') || 'main-stage',

  // Role is a URL param FOR NOW (?role=speaker). Real gating — Lightning slot
  // booking — arrives in a later prompt; this is the seam it plugs into.
  role: params.get('role') === 'speaker' ? 'speaker' : 'listener',

  // Designated "next up" — may enter the under-stage green room. PLACEHOLDER: set
  // via ?slot=next for now; Phase 3's zap/request queue becomes the real source.
  isNextUp: params.get('slot') === 'next',

  // A throwaway per-tab identity until Nostr login lands (Prompt 2). Stable for
  // the life of the page so presence/voice agree on who we are.
  identity: `${params.get('role') === 'speaker' ? 'spk' : 'lis'}-${Math.random().toString(36).slice(2, 8)}`,
};
