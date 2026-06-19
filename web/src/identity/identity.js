// identity/identity.js — the ONE source of identity. Everything that needs a name,
// face, npub, or signature goes through this service. It's a MOCK now (no real keys,
// relays, or network), but its surface matches the real Nostr shapes so swapping in
// nostr-tools + NIP-07 later is a module swap, not a rewrite:
//
//   Identity = { pubkey (hex), npub, name, picture, nip05, lud16 }
//   signIn(method)       'nip07' | 'generate' | 'guest' → async Identity
//   current()            → Identity | null
//   getProfile(pubkey)   → async { name, picture, nip05, lud16 }  (real: kind:0 from relays)
//   signEvent(event)     → async event w/ id/sig/pubkey            (real: window.nostr.signEvent)
//   logout()
//
// Swap rules baked in: everything is keyed by **pubkey (hex)**; getProfile + signIn +
// signEvent are **async**; the Identity carries **lud16** (zaps need it); and mock
// data is **deterministic** from the pubkey (same seed → same name/face forever, no
// per-frame randomness). The wallet/zap service is separate (a later slice).

// ── deterministic hashing (mock substrate) ──────────────────────────────────────
function strSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// pubkey: a deterministic 64-hex string from any seed — the mock stand-in for a real
// key. REAL: a participant's actual pubkey arrives over presence; you'd skip this.
export function pubkeyFromSeed(seed) {
  const rnd = mulberry32(strSeed('pk:' + seed));
  let hex = '';
  for (let i = 0; i < 32; i++) hex += Math.floor(rnd() * 256).toString(16).padStart(2, '0');
  return hex;
}

// npub: REAL is bech32(pubkey); MOCK is a deterministic npub-SHAPED string.
export function npubFromPubkey(pubkey) {
  const rnd = mulberry32(strSeed('npub:' + pubkey));
  const cs = '023456789acdefghjklmnpqrstuvwxyz'; // bech32 charset
  let s = 'npub1';
  for (let i = 0; i < 58; i++) s += cs[Math.floor(rnd() * cs.length)];
  return s;
}

// ── deterministic mock profile (kind:0 stand-in) ────────────────────────────────
const ADJ = ['Swift', 'Lumen', 'Nova', 'Quiet', 'Solar', 'Vivid', 'Amber', 'Cobalt',
  'Cipher', 'Ember', 'Lunar', 'Brisk', 'Onyx', 'Zephyr', 'Mellow', 'Stark'];
const NOUN = ['Otter', 'Falcon', 'Maple', 'Quartz', 'Heron', 'Comet', 'Willow', 'Lynx',
  'Cedar', 'Raven', 'Koi', 'Vireo', 'Sable', 'Wren', 'Fox', 'Marten'];
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

function buildProfile(pubkey) {
  const b = pubkey.match(/../g).map((h) => parseInt(h, 16));
  const name = `${ADJ[b[0] % ADJ.length]} ${NOUN[b[1] % NOUN.length]}`;
  return {
    name,
    picture: null,                        // MOCK has no image → caller draws a keyface
    nip05: `${slug(name)}@xrstage.mock`,   // fake verified handle
    lud16: `${slug(name)}@zap.mock`,       // fake Lightning address — REAL zaps need this
  };
}

function identityFor(seed) {
  const pubkey = pubkeyFromSeed(seed);
  return { pubkey, npub: npubFromPubkey(pubkey), ...buildProfile(pubkey) };
}

// Persisted guest seed → the local mock identity is stable across reloads.
const GUEST_SEED_KEY = 'xrstage:guestSeed';
function guestSeed() {
  try {
    let s = localStorage.getItem(GUEST_SEED_KEY);
    if (!s) { s = 'guest-' + Math.random().toString(36).slice(2, 10); localStorage.setItem(GUEST_SEED_KEY, s); }
    return s;
  } catch { return 'guest-fallback'; }
}

let _current = null;

export const identity = {
  // method: 'nip07' | 'generate' | 'guest'. MOCK ignores the distinction and returns
  // a deterministic guest identity. REAL: nip07 → window.nostr.getPublicKey();
  // generate → fresh keypair (mobile/VR); guest → ephemeral key.
  async signIn(method = 'guest') { // eslint-disable-line no-unused-vars
    _current = identityFor(guestSeed());
    return _current;
  },

  current() { return _current; },
  logout() { _current = null; },

  // Async even though the mock is instant — REAL fetches kind:0 metadata from relays.
  async getProfile(pubkey) { return buildProfile(pubkey); },

  // MOCK stamps a deterministic fake id/sig/pubkey. REAL: window.nostr.signEvent(event).
  async signEvent(event) {
    const pubkey = (_current && _current.pubkey) || pubkeyFromSeed('anon');
    return {
      ...event,
      pubkey,
      created_at: event.created_at ?? Math.floor(Date.now() / 1000),
      id: pubkeyFromSeed('id:' + pubkey + JSON.stringify(event)),                 // 64 hex
      sig: pubkeyFromSeed('sig:' + pubkey) + pubkeyFromSeed('sig2:' + pubkey + JSON.stringify(event)), // 128 hex
    };
  },

  // Mock helpers (the substrate for "this participant's pubkey"). REAL presence
  // carries the real pubkey, so callers use getProfile(pubkey) directly.
  pubkeyFromSeed,
  npubFromPubkey,
};
