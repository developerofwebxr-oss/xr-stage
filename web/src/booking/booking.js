import { wallet } from '../wallet/wallet.js';
import { identity } from '../identity/identity.js';

// booking/booking.js — the ONE source of stage-slot bookings: who's speaking when. MOCK,
// same pattern as identity/wallet/board/queue, so the real version (a booking backend /
// Nostr calendar events) is a swap:
//
//   slots()                    → ordered upcoming slots [{ id, startsAt, durationMin, price, bookedBy|null, title|null }]
//   book({ slotId, title })    async → charges via wallet.zap (charge-on-confirmed), sets bookedBy = me
//   mine()                     → my booked slot(s) | []
//   cancel(slotId)             → frees the slot. NO REFUND (consistent with the economy)
//   nowAndNext()               → { now: slot|null, next: slot|null } for the schedule
//   onChange(cb)               → fires on book/cancel; returns unsub
//
// Booking requires a signed-in identity + a connected wallet; charge-on-confirmed;
// insufficient → clean failure; a taken slot can't be double-booked. All booking state
// lives HERE — nowhere else.

const SLOT_MIN = 30;      // minutes per slot
const N_SLOTS = 8;        // a simple upcoming grid
const PRICE = 1000;       // flat price, sats
const TITLE_MAX = 60;
const SINK = identity.pubkeyFromSeed('stage-house'); // where booking payments go (mock house)

// Generate the grid once, anchored to the current 30-min boundary so slot 0 is the
// live window (booking it makes it "now"). Uses wall-clock — booking is inherently
// time-based (unlike the deterministic board/queue seeds).
const _slotMs = SLOT_MIN * 60_000;
const _base = Math.floor(Date.now() / _slotMs) * _slotMs;
const _slots = Array.from({ length: N_SLOTS }, (_, i) => ({
  id: `s${i}`,
  startsAt: _base + i * _slotMs,
  durationMin: SLOT_MIN,
  price: PRICE,
  bookedBy: null,
  title: null,
}));

const _subs = new Set();
const emit = () => { for (const cb of _subs) cb(); };

export const booking = {
  PRICE, TITLE_MAX,

  slots() { return _slots.map((s) => ({ ...s })); }, // ordered by construction; copies

  async book({ slotId, title } = {}) {
    const me = identity.current();
    if (!me) return { state: 'failed', reason: 'not signed in' };
    if (!wallet.isConnected()) return { state: 'failed', reason: 'wallet not connected' };
    const slot = _slots.find((s) => s.id === slotId);
    if (!slot) return { state: 'failed', reason: 'no such slot' };
    if (slot.bookedBy) return { state: 'failed', reason: 'slot taken' }; // no double-booking
    const res = await wallet.zap({ toPubkey: SINK, amountSats: slot.price, note: `book slot ${slotId}` });
    if (res.state !== 'confirmed') return res;                          // insufficient → nothing booked
    slot.bookedBy = me.pubkey;
    slot.title = String(title || '').slice(0, TITLE_MAX) || 'Untitled talk';
    emit();
    return res;
  },

  mine() {
    const me = identity.current();
    if (!me) return [];
    return _slots.filter((s) => s.bookedBy === me.pubkey).map((s) => ({ ...s }));
  },

  cancel(slotId) {
    const slot = _slots.find((s) => s.id === slotId);
    if (slot && slot.bookedBy) { slot.bookedBy = null; slot.title = null; emit(); } // NO REFUND
  },

  nowAndNext() {
    const t = Date.now();
    const booked = _slots.filter((s) => s.bookedBy);
    const now = booked.find((s) => s.startsAt <= t && t < s.startsAt + s.durationMin * 60_000) || null;
    const next = booked.filter((s) => s.startsAt >= t).sort((a, b) => a.startsAt - b.startsAt)[0] || null;
    return { now: now ? { ...now } : null, next: next && next !== now ? { ...next } : null };
  },

  onChange(cb) { _subs.add(cb); return () => _subs.delete(cb); },
};
