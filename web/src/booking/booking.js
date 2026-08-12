import { identity } from '../identity/identity.js';
import { tickets } from '../tickets/tickets.js';

// booking/booking.js — the ONE source of stage bookings, now expressed as EVENTS. The venue is
// a marketplace of events: every booking creates an event; tickets + speaker money are scoped to
// events (see tickets.js). MOCK, same swap-friendly pattern.
//
//   Event = { id, title, ownerPubkey, startsAt, endsAt, speakers:[pubkeys], slotIds:[] }
//     One 10-min slot = a small event; consecutive slots (≤ MAX_EVENT_SLOTS) = one larger event.
//     owner = organizer; `speakers[]` exists as the co-speaker SEAM (owner-only for now).
//
//   events() · event(id) · currentEvent() · nextEvent() · activeOrNextEvent()
//   slots()                       → the raw grid (taken/free/title/mine) for the booking UI
//   book({ slotId, slots, title }) async → books `slots` consecutive free slots as ONE event
//   mine()                        → events I own | []
//   cancel(eventId)               → frees the event's slots (NO refund; KEEPS the speaker pass)
//   nowAndNext()                  → { now: event|null, next: event|null } for the schedule
//   now()                         → the mock clock (dev time-skip aware)   ·   onChange(cb)
//
// SPEAKER PATH unchanged: booking needs only a SIGNED-IN identity (no attendee ticket). The slot
// fee is a mock EXTERNAL entry payment (not from credits), 100% to the venue as stage rent
// (tickets.recordVenue), and grants the SPEAKER PASS scoped to the new event (tickets.grant…).

const SLOT_PRICE_PER_10MIN = 10000; // sats per 10-minute slot — LINEAR with duration
const SLOT_MIN = 10;                // minutes per slot
const N_SLOTS = 12;                 // upcoming grid
const PENDING_MS = 1000;            // mock external-payment settle
const TITLE_MAX = 60;
const MAX_EVENT_SLOTS = 3;          // book up to 3 consecutive slots as ONE event (minimal grouping)
const priceFor = (durationMin) => Math.round((durationMin / 10) * SLOT_PRICE_PER_10MIN);

// ── Mock clock ────────────────────────────────────────────────────────────────────────
// Events run on the real clock against mock slots. `_skew` is a DEV-ONLY time-skip (booking.__skip)
// so event-boundary flows can be verified without waiting 10 real minutes. Prod-harmless (local).
let _skew = 0;
const now = () => Date.now() + _skew;

const _slotMs = SLOT_MIN * 60_000;
const _base = Math.floor(Date.now() / _slotMs) * _slotMs; // slot 0 is the live window
const _slots = Array.from({ length: N_SLOTS }, (_, i) => ({
  id: `s${i}`, startsAt: _base + i * _slotMs, durationMin: SLOT_MIN, price: priceFor(SLOT_MIN), eventId: null,
}));

let _eventSeq = 0;
const _events = new Map(); // id → event
const _subs = new Set();
const emit = () => { for (const cb of _subs) cb(); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEvent({ title, ownerPubkey, slotList }) {
  const id = `e${++_eventSeq}`;
  const last = slotList[slotList.length - 1];
  const ev = {
    id, title, ownerPubkey,
    startsAt: slotList[0].startsAt,
    endsAt: last.startsAt + last.durationMin * 60_000,
    speakers: [ownerPubkey],           // SEAM: co-speakers append here later (owner-only now)
    slotIds: slotList.map((s) => s.id),
  };
  _events.set(id, ev);
  for (const s of slotList) s.eventId = id;
  return ev;
}

// Seed a few mock events so the schedule + event transitions have content out of the box.
(function seed() {
  const spk = (i) => identity.pubkeyFromSeed(`speaker-${i}`);
  makeEvent({ title: 'Opening Keynote', ownerPubkey: spk(0), slotList: [_slots[0]] });
  makeEvent({ title: 'Lightning & Nostr', ownerPubkey: spk(1), slotList: [_slots[1]] });
  makeEvent({ title: 'Fireside: self-custody', ownerPubkey: spk(2), slotList: [_slots[2], _slots[3]] }); // 20-min
})();

const copy = (e) => (e ? { ...e, speakers: [...e.speakers], slotIds: [...e.slotIds] } : null);

export const booking = {
  SLOT_PRICE_PER_10MIN, SLOT_MIN, TITLE_MAX, MAX_EVENT_SLOTS, priceFor, now,

  events() { return [..._events.values()].sort((a, b) => a.startsAt - b.startsAt).map(copy); },
  event(id) { return copy(_events.get(id)); },
  currentEvent() { const t = now(); return copy([..._events.values()].find((e) => e.startsAt <= t && t < e.endsAt)); },
  nextEvent() { const t = now(); return copy([..._events.values()].filter((e) => e.startsAt > t).sort((a, b) => a.startsAt - b.startsAt)[0]); },
  // The event a ticket purchase applies to: the running one, else the next to start.
  activeOrNextEvent() { return this.currentEvent() || this.nextEvent(); },

  // Raw slot grid for the booking UI (taken/free + owning event title).
  slots() {
    const me = identity.current();
    return _slots.map((s) => {
      const ev = s.eventId ? _events.get(s.eventId) : null;
      return { ...s, taken: !!ev, title: ev ? ev.title : null, mine: !!(ev && me && ev.ownerPubkey === me.pubkey) };
    });
  },

  async book({ slotId, slots = 1, title } = {}) {
    const me = identity.current();
    if (!me) return { state: 'failed', reason: 'not signed in' }; // sign-in only — no attendee ticket
    const start = _slots.findIndex((s) => s.id === slotId);
    if (start < 0) return { state: 'failed', reason: 'no such slot' };
    const n = Math.max(1, Math.min(MAX_EVENT_SLOTS, slots | 0));
    const chosen = _slots.slice(start, start + n);
    if (chosen.length < n) return { state: 'failed', reason: 'not enough slots' };
    if (chosen.some((s) => s.eventId)) return { state: 'failed', reason: 'slot taken' };

    await delay(PENDING_MS); // mock external ENTRY PAYMENT (stage rent), not from credits
    if (chosen.some((s) => s.eventId)) return { state: 'failed', reason: 'slot taken' };
    const ev = makeEvent({ title: String(title || '').slice(0, TITLE_MAX) || 'Untitled talk', ownerPubkey: me.pubkey, slotList: chosen });
    const rent = chosen.reduce((a, s) => a + s.price, 0);
    tickets.recordVenue(rent);            // 100% to the venue (stage rent) — never a speaker pot
    tickets.grantSpeakerPass(ev.id);      // booking IS the speaker's ticket — scoped to THIS event
    emit();
    return { state: 'confirmed', price: rent, eventId: ev.id, event: copy(ev) };
  },

  mine() {
    const me = identity.current();
    if (!me) return [];
    return [..._events.values()].filter((e) => e.ownerPubkey === me.pubkey).sort((a, b) => a.startsAt - b.startsAt).map(copy);
  },

  cancel(eventId) {
    const ev = _events.get(eventId);
    if (!ev) return;
    for (const sid of ev.slotIds) { const s = _slots.find((x) => x.id === sid); if (s) s.eventId = null; }
    _events.delete(eventId); // NO refund; the speaker pass is KEPT (policy)
    emit();
  },

  nowAndNext() { return { now: this.currentEvent(), next: this.nextEvent() }; },
  onChange(cb) { _subs.add(cb); return () => _subs.delete(cb); },

  // DEV-ONLY mock time-skip (flagged) — advance the clock by `min` minutes to test event
  // boundaries (grace expiry, next-event start) without waiting. No UI; console/handle only.
  __skip(min) { _skew += min * 60_000; emit(); },
};
