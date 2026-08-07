import { identity } from '../identity/identity.js';

// board/board.js — the ONE source of comments. MOCK now (in-memory), but its surface
// matches the real shape (Nostr text notes + zap receipts later) so swapping in real
// events is a module swap, not a rewrite:
//
//   post({ pubkey, text })   → create a comment (keyed by SENDER pubkey), returns it
//   boost(id, sats)          → zap an existing comment (accumulates zapped sats + count)
//   get(id)                  → a comment | null
//   recent(n)                → newest-last, for the live feed
//   top(n)                   → most-zapped first, for the top wall
//   byPubkey(pubkey)         → comments this pubkey has sent (for the You→Activity list)
//   onChange(cb)             → fires on post/boost so the screens re-render; returns unsub
//
// Swap rules baked in: comments are keyed by **sender pubkey** (real: the note author);
// posting/boosting is driven by the wallet service (charge on confirmed) OUTSIDE this
// module — the board only records the result. No network, no per-frame work.

export const MAX_LEN = 140;

let _seq = 0;
const _comments = new Map(); // id → { id, pubkey, text, sats, count, createdAt }
const _subs = new Set();
const emit = () => { for (const cb of _subs) cb(); };

function add(pubkey, text, sats, count, createdAt) {
  const id = `c${++_seq}`;
  _comments.set(id, { id, pubkey, text: String(text).slice(0, MAX_LEN), sats, count, createdAt });
  return _comments.get(id);
}

// Seed a little content so the screens aren't empty on load. Keyed to the seeded
// avatars' pubkeys (so boosting a comment sparkles the right body). MOCK only.
(function seed() {
  const S = (i) => identity.pubkeyFromSeed(`seed-${i}`);
  const now = 1_700_000_000_000; // fixed base (deterministic ordering; not Date.now)
  add(S(0), 'gm — pumped for this talk ⚡',            120, 6, now - 60_000);
  add(S(1), 'what wallet are you running on stage?',    340, 12, now - 50_000);
  add(S(2), 'zapped! great point on self-custody',       21, 1, now - 40_000);
  add(S(0), 'can you compare NWC vs LNbits?',           520, 18, now - 30_000);
  add(S(1), '+1, audio is crisp in here',                 0, 0, now - 20_000);
  add(S(2), 'first time in VR for a meetup, love it',    63, 3, now - 10_000);
})();

let _clock = 1_700_000_100_000; // monotonic stamp for new posts (no Date.now dependency)

export const board = {
  MAX_LEN,
  post({ pubkey, text }) {
    const c = add(pubkey, text, 0, 0, (_clock += 1000));
    emit();
    return c;
  },
  boost(id, sats = 21) {
    const c = _comments.get(id);
    if (c) { c.sats += sats; c.count += 1; emit(); }
    return c || null;
  },
  get(id) { return _comments.get(id) || null; },
  list() { return [..._comments.values()].sort((a, b) => a.createdAt - b.createdAt); }, // oldest→newest
  recent(n = 8) { return this.list().slice(-n); },
  top(n = 5) {
    return [..._comments.values()]
      .filter((c) => c.sats > 0)
      .sort((a, b) => b.sats - a.sats || b.createdAt - a.createdAt)
      .slice(0, n);
  },
  byPubkey(pubkey) { return this.list().filter((c) => c.pubkey === pubkey).reverse(); }, // newest-first
  onChange(cb) { _subs.add(cb); return () => _subs.delete(cb); },
};
