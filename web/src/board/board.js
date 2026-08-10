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

// Seed enough content that the LIVE feed is SCROLLABLE out of the box — more than the
// feed's visible window (FEED_N in commentBoard) so there's older history to scroll back
// to; otherwise scrolling silently no-ops on a fresh page. Keyed to the seeded avatars'
// pubkeys (so boosting a comment sparkles the right body). MOCK only.
(function seed() {
  const S = (i) => identity.pubkeyFromSeed(`seed-${i % 3}`);
  const now = 1_700_000_000_000; // fixed base (deterministic ordering; not Date.now)
  const lines = [
    ['gm everyone 👋',                               8,  1],
    ['excited for this one',                         0,  0],
    ['is this being recorded?',                     21,  1],
    ['love the spatial setup',                      42,  2],
    ['zapping from Tokyo 🗾',                        99,  4],
    ['what relay are you on?',                       12,  1],
    ['first meetup in VR, wild',                    150,  6],
    ['gm — pumped for this talk ⚡',                 120,  6],
    ['what wallet are you running on stage?',       340, 12],
    ['zapped! great point on self-custody',          21,  1],
    ['can you compare NWC vs LNbits?',              520, 18],
    ['+1, audio is crisp in here',                    0,  0],
    ['first time in VR for a meetup, love it',       63,  3],
  ];
  lines.forEach(([text, sats, count], i) => add(S(i), text, sats, count, now - (lines.length - i) * 10_000));
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
  count() { return _comments.size; },
  list() { return [..._comments.values()].sort((a, b) => a.createdAt - b.createdAt); }, // oldest→newest
  // A window of n comments, `offset` steps back from the newest (0 = live/newest). Only
  // exposes older comments for windowed rendering — the shared data is unchanged; the
  // scroll offset itself lives in the client (never here, never broadcast).
  recent(n = 8, offset = 0) {
    const l = this.list();
    const end = Math.max(0, l.length - Math.max(0, offset));
    return l.slice(Math.max(0, end - n), end);
  },
  top(n = 5) {
    return [..._comments.values()]
      .filter((c) => c.sats > 0)
      .sort((a, b) => b.sats - a.sats || b.createdAt - a.createdAt)
      .slice(0, n);
  },
  byPubkey(pubkey) { return this.list().filter((c) => c.pubkey === pubkey).reverse(); }, // newest-first
  onChange(cb) { _subs.add(cb); return () => _subs.delete(cb); },
};
