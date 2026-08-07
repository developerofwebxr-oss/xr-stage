import { wallet } from '../wallet/wallet.js';
import { identity } from '../identity/identity.js';

// queue/queue.js — the ONE source of the paid "take the mic" queue: who's waiting to
// speak at the pedestal/floor mic (the QUESTIONER spot, not the main stage). MOCK, same
// pattern as identity/wallet/board, so the real version (Nostr + real zaps) is a swap:
//
//   join({ pubkey, amountSats, pitch })  async → charges via wallet.zap (charge-on-
//                                        confirmed), then adds or accumulates the entrant
//   topUp({ pubkey, amountSats })        async → zap more; amounts accumulate; re-rank
//   list()                               → ordered entries [{ pubkey, totalSats, pitch, joinedAt }]
//   position(pubkey)                     → 1-based position | null
//   count()                              → number waiting
//   criteria() / setCriteria(c)          → 'money' (implemented) | 'activity' | 'manual'
//                                          (recognized but not implemented yet)
//   remove(pubkey) / next()              → host/speaker actions (leave-queue / advance)
//   current()                            → the entrant most recently advanced ("up")
//   onChange(cb)                         → fires on any change; returns unsub
//
// Locked model: paying to enter is a zap (NO REFUNDS — un-picked entrants keep no mic,
// their sats stay). Ordering is a SERVICE PARAMETER (the Speaker hub will expose the
// toggle later); default + only implemented mode is Money = highest cumulative zap first,
// ties broken by earlier joinedAt. All queue state lives HERE — nowhere else.

const PITCH_MAX = 80;
const SINK = identity.pubkeyFromSeed('mic-house'); // where queue-entry zaps go (mock house)
const CRITERIA = new Set(['money', 'activity', 'manual']);

const _entries = new Map(); // pubkey → { pubkey, totalSats, pitch, joinedAt }
const _subs = new Set();
let _criteria = 'money';
let _current = null;        // the entrant advanced to the mic ("you're up")
let _clock = 1;             // monotonic joinedAt stamp (no Date.now → deterministic)
const emit = () => { for (const cb of _subs) cb(); };

function ordered() {
  const arr = [..._entries.values()];
  // Money: highest cumulative zap first, ties → earlier joiner first. Activity/Manual
  // are recognized but unimplemented — fall back to arrival order so list() is stable.
  if (_criteria === 'money') arr.sort((a, b) => b.totalSats - a.totalSats || a.joinedAt - b.joinedAt);
  else arr.sort((a, b) => a.joinedAt - b.joinedAt);
  return arr;
}

export const queue = {
  PITCH_MAX,

  async join({ pubkey, amountSats, pitch } = {}) {
    const res = await wallet.zap({ toPubkey: SINK, amountSats, note: 'mic-queue: join' });
    if (res.state !== 'confirmed') return res; // insufficient / failed → nothing joins
    const e = _entries.get(pubkey);
    if (e) {                                    // already waiting → accumulate + update pitch
      e.totalSats += amountSats;
      if (pitch != null) e.pitch = String(pitch).slice(0, PITCH_MAX);
    } else {
      _entries.set(pubkey, {
        pubkey, totalSats: amountSats,
        pitch: pitch ? String(pitch).slice(0, PITCH_MAX) : '',
        joinedAt: _clock++,
      });
    }
    emit();
    return res;
  },

  async topUp({ pubkey, amountSats } = {}) {
    const e = _entries.get(pubkey);
    if (!e) return { state: 'failed', reason: 'not in queue' };
    const res = await wallet.zap({ toPubkey: SINK, amountSats, note: 'mic-queue: top up' });
    if (res.state !== 'confirmed') return res;
    e.totalSats += amountSats;                  // accumulate → climbs the Money ranking
    emit();
    return res;
  },

  list() { return ordered(); },
  position(pubkey) {
    const i = ordered().findIndex((e) => e.pubkey === pubkey);
    return i === -1 ? null : i + 1;
  },
  count() { return _entries.size; },
  entry(pubkey) { return _entries.get(pubkey) || null; },

  criteria() { return _criteria; },
  setCriteria(c) { if (CRITERIA.has(c)) { _criteria = c; emit(); } return _criteria; },

  // Host/speaker actions — wired to a debug path now; the Speaker hub adds the UI later.
  remove(pubkey) { if (_entries.delete(pubkey)) emit(); },
  next() {
    const up = ordered()[0] || null;
    if (up) { _entries.delete(up.pubkey); _current = up; emit(); } // front entrant is now "up"
    return up;
  },
  current() { return _current; },

  onChange(cb) { _subs.add(cb); return () => _subs.delete(cb); },
};
