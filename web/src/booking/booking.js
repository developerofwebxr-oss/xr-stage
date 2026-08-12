import { identity } from '../identity/identity.js';
import { tickets } from '../tickets/tickets.js';

// booking/booking.js — the ONE source of stage-slot bookings: who's speaking when. MOCK,
// same pattern as identity/wallet/board/queue, so the real version (a booking backend /
// Nostr calendar events) is a swap:
//
//   slots()                    → ordered upcoming slots [{ id, startsAt, durationMin, price, bookedBy|null, title|null }]
//   book({ slotId, title })    async → mock external ENTRY PAYMENT (stage rent), sets bookedBy = me
//   mine()                     → my booked slot(s) | []
//   cancel(slotId)             → frees the slot. NO REFUND, and KEEPS the speaker pass (policy)
//   nowAndNext()               → { now: slot|null, next: slot|null } for the schedule
//   onChange(cb)               → fires on book/cancel; returns unsub
//
// SPEAKER PATH: booking requires only a SIGNED-IN identity (no attendee ticket). The slot fee is
// a mock EXTERNAL entry payment (NOT from local credits — same custody-free pattern as tickets),
// goes 100% to the venue as stage rent (tickets.recordVenue — NEVER the speaker pool), and on a
// confirmed booking grants the SPEAKER PASS (tickets.grantSpeakerPass): booking IS the ticket.

// ── Config (tuned per event) ────────────────────────────────────────────────────────────
const SLOT_PRICE_PER_10MIN = 10000; // sats per 10-minute slot — price is LINEAR with duration
const SLOT_MIN = 10;                // minutes per slot
const N_SLOTS = 8;                  // a simple upcoming grid
const PENDING_MS = 1000;            // mock external-payment settle (matches wallet/tickets)
const TITLE_MAX = 60;
// POLICY: cancelling frees the slot (no refund) but KEEPS the speaker pass for the session —
// simple + generous (you paid the stage rent; the pass doesn't expire). Flip to revoke later.
const KEEP_PASS_ON_CANCEL = true;

const priceFor = (durationMin) => Math.round((durationMin / 10) * SLOT_PRICE_PER_10MIN);

// Generate the grid once, anchored to the current slot boundary so slot 0 is the live window.
// Uses wall-clock — booking is inherently time-based (unlike the deterministic board/queue seeds).
const _slotMs = SLOT_MIN * 60_000;
const _base = Math.floor(Date.now() / _slotMs) * _slotMs;
const _slots = Array.from({ length: N_SLOTS }, (_, i) => ({
  id: `s${i}`,
  startsAt: _base + i * _slotMs,
  durationMin: SLOT_MIN,
  price: priceFor(SLOT_MIN),
  bookedBy: null,
  title: null,
}));

const _subs = new Set();
const emit = () => { for (const cb of _subs) cb(); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export const booking = {
  SLOT_PRICE_PER_10MIN, SLOT_MIN, TITLE_MAX, priceFor,

  slots() { return _slots.map((s) => ({ ...s })); }, // ordered by construction; copies

  async book({ slotId, title } = {}) {
    const me = identity.current();
    if (!me) return { state: 'failed', reason: 'not signed in' }; // sign-in only — no attendee ticket
    const slot = _slots.find((s) => s.id === slotId);
    if (!slot) return { state: 'failed', reason: 'no such slot' };
    if (slot.bookedBy) return { state: 'failed', reason: 'slot taken' }; // no double-booking

    // ENTRY PAYMENT — mock external (NOT from local credits). REAL: pay a Lightning invoice.
    await delay(PENDING_MS);
    if (slot.bookedBy) return { state: 'failed', reason: 'slot taken' }; // re-check after settle
    slot.bookedBy = me.pubkey;
    slot.title = String(title || '').slice(0, TITLE_MAX) || 'Untitled talk';
    tickets.recordVenue(slot.price);  // 100% to the venue (stage rent) — NEVER the speaker pool
    tickets.grantSpeakerPass();       // booking IS the speaker's ticket → embodiment + pass
    emit();
    return { state: 'confirmed', price: slot.price };
  },

  mine() {
    const me = identity.current();
    if (!me) return [];
    return _slots.filter((s) => s.bookedBy === me.pubkey).map((s) => ({ ...s }));
  },

  cancel(slotId) {
    const slot = _slots.find((s) => s.id === slotId);
    if (slot && slot.bookedBy) {
      slot.bookedBy = null; slot.title = null; // NO REFUND
      // KEEP_PASS_ON_CANCEL: the speaker pass stays (we don't call any revoke). See policy above.
      emit();
    }
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
