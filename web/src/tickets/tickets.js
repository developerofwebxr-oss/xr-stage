import { wallet } from '../wallet/wallet.js';

// tickets/tickets.js — the ONE source of TIER + EMBODIMENT state. The venue's business model:
// free visitors are GHOSTS (listen only, no body); a one-time paid TICKET per identity buys
// embodiment + venue CREDITS + perks. MOCK now, but the seam matches the real thing.
//
//   tier()              → 'ghost' | 'basic' | 'supporter' | 'patron'   (ATTENDEE tier)
//   buy(tier, eventId)  → pending→confirmed|failed; sets tier for THAT event + credits the wallet
//   split(tier)         → { price, venue, speakers, credits } — the transparent per-tier math
//   speakerPass()       → true once you've BOOKED (a parallel pass — NOT an attendee tier)
//   grantSpeakerPass(eventId) → set the pass for the booked event (called by booking)
//   heldEventId()/holdsFor(eventId) → which event your ticket/pass is scoped to
//   lapseToGhost()      → event ended+grace over / declined → ghost; KEEPS identity+credits+history
//   flags()             → { badge, speaker, networkingPriority, networkingAccess, smokingAccess,
//                           frontRow, sponsorSpot, backstageAccess }
//   visible()/setVisible(bool) → embodiment toggle for MEMBERS (paid tier OR speaker pass)
//   purchaseAccess(kind)→ micro-purchase: spend CREDITS for an access flag (networking/smoking/frontRow)
//   speakerPot(eventId) → sats accrued for THAT event's speakers (per-event, replaces the old pool)
//   venueRevenue()      → total sats to the venue (ticket fees + slot rent); recordVenue(sats) adds
//   lastSplit()/prevTier() · activate(pubkey)/deactivate() · onChange(cb)
//
// EVENT-SCOPED: tickets belong to an event; the speaker share goes to that event's pot; a pass is
// valid through its event + grace. Event validity/lapse timing is driven by main's transition
// engine (this module is booking-agnostic — event ids are opaque strings passed in).
//
// SPEAKER PATH: booking a slot IS the speaker's ticket — no attendee tier needed. It grants a
// parallel SPEAKER PASS (embodiment + 🎙 badge + networking/smoking access + a backstage seam
// flag), coexisting with any attendee tier (a Patron who books keeps both perk sets). The pass
// persists for the session/per-pubkey and is NOT revoked when the talk ends.
//
// ── MONEY FLOW (mock, custody-free "arcade ticket" model) ──────────────────────────────
// Buying a ticket is the ENTRY PAYMENT — it does NOT come from your local credit balance.
// It's a mock "external" payment (real: a Lightning invoice you pay to the venue). On settle
// the price splits three ways (see below): the VENUE fee, the SPEAKER pool share, and your
// CREDITS (the remainder, added to your wallet). Micro-purchases (purchaseAccess) are the
// opposite direction — they SPEND credits back to the venue. Persisted PER PUBKEY.
//
// ── SPEAKER-POOL DISTRIBUTION SEAM (later slice — do NOT build here) ────────────────────
// speakerPool() accumulates every ticket's speaker share into ONE venue-global pot. At go-real
// it will be SPLIT AMONG THE BOOKED SLOT-HOLDERS BY STAGE TIME (the booking service knows each
// slot's duration) and paid out over Lightning. That distribution — and its guardrails — is a
// booking + Lightning slice. This module only GROWS the pot; `booking` stays untouched.

const PENDING_MS = 1000; // simulated settle latency (deterministic; matches the wallet)

// ── Ticket economics (tunable config) ──────────────────────────────────────────────────
// FLAT venue fee on every tier; PROGRESSIVE speaker share by tier; credits = the remainder.
// Prices keep the 21-motif (2,100 / 10,000 / 21,000).
const VENUE_FEE = 0.10;                                   // flat 10%, every tier
const SPEAKER_SHARE = { basic: 0.10, supporter: 0.20, patron: 0.30 }; // progressive

// Tier catalogue. `price` = external entry payment (sats); `flags` = the perks the tier includes.
// The venue/speaker/credits split is DERIVED from the config above via split() — not stored here.
export const TIERS = {
  ghost:     { label: 'Ghost',     price: 0,     flags: {} },
  basic:     { label: 'Basic',     price: 2100,  flags: {} },
  supporter: { label: 'Supporter', price: 10000,
    flags: { badge: 'supporter', networkingPriority: true, networkingAccess: true, smokingAccess: true } },
  patron:    { label: 'Patron',    price: 21000,
    flags: { badge: 'patron', networkingPriority: true, networkingAccess: true, smokingAccess: true, frontRow: true, sponsorSpot: true } },
};

// The transparent split for a tier: venue fee + speaker share + credits (remainder = price − the
// two shares, so it always reconciles exactly). → { price, venue, speakers, credits }.
export function splitFor(tierName) {
  const t = TIERS[tierName];
  if (!t || !t.price) return { price: 0, venue: 0, speakers: 0, credits: 0 };
  const venue = Math.round(t.price * VENUE_FEE);
  const speakers = Math.round(t.price * (SPEAKER_SHARE[tierName] || 0));
  return { price: t.price, venue, speakers, credits: t.price - venue - speakers };
}

// Micro-purchase catalogue (credits → venue). Only these kinds are RECOGNISED; a kind maps to
// the access flag it unlocks. frontRow is recognised by the seam but has no zone yet, so the
// UI only OFFERS networking/smoking (the zones that exist) — no "coming soon" surfaces.
const ACCESS = {
  networking: { price: 500,  flag: 'networkingAccess' },
  smoking:    { price: 500,  flag: 'smokingAccess' },
  frontRow:   { price: 1000, flag: 'frontRow' },
};

let activePubkey = null;
let _tier = 'ghost';
let _ticketEventId = null;        // the EVENT this attendee ticket is for (null = none)
let _visible = true;              // embodied by default once a member (ghosts ignore this)
let _access = new Set();          // extra access kinds bought à la carte (Basic)
let _speaker = false;             // SPEAKER PASS — true once you've booked
let _speakerEventId = null;       // the EVENT you're speaking at
let _lastSplit = null;            // this identity's most recent purchase split (persisted)
let _prevTier = null;             // badge-history: the highest attendee tier ever held (kept on lapse)
let seq = 0;
const subs = new Set();
const emit = () => { for (const cb of subs) cb(snapshot()); };

const storeKey = (pk) => `xrstage:ticket:${pk}`;
function persist() {
  if (!activePubkey) return;
  try {
    localStorage.setItem(storeKey(activePubkey), JSON.stringify({
      tier: _tier, ticketEventId: _ticketEventId, visible: _visible, access: [..._access],
      speaker: _speaker, speakerEventId: _speakerEventId, lastSplit: _lastSplit, prevTier: _prevTier,
    }));
  } catch { /* private mode */ }
}

// Per-EVENT speaker pots (venue-global, persisted): { eventId: sats }. Each attendee ticket's
// speaker share accrues to ITS event's pot — split among that event's speakers by stage time at
// payout (seam, per event). Replaces the old global pool (dropped — mock data). Venue revenue
// (ticket fees + slot rent) is a single global counter, never a pot.
const POTS_KEY = 'xrstage:eventPots', VENUE_KEY = 'xrstage:venueRevenue';
const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
let _pots = loadJSON(POTS_KEY, {});
let _venue = (() => { try { return Number(localStorage.getItem(VENUE_KEY)) || 0; } catch { return 0; } })();
function growPot(eventId, sats) { if (!eventId || !sats) return; _pots[eventId] = (_pots[eventId] || 0) + sats; try { localStorage.setItem(POTS_KEY, JSON.stringify(_pots)); } catch { /* private */ } }
function addVenue(sats) { if (!sats) return; _venue += sats; try { localStorage.setItem(VENUE_KEY, String(_venue)); } catch { /* private */ } }

function snapshot() { return { tier: tierNow(), flags: flagsNow(), visible: visibleNow(), speaker: speakerNow(), heldEventId: heldEventId() }; }

function tierNow() { return activePubkey ? _tier : 'ghost'; }
function speakerNow() { return !!activePubkey && _speaker; }
// A MEMBER = holds a paid attendee tier OR a speaker pass → embodied (subject to the toggle).
// Event VALIDITY (grace, lapse) is enforced by the transition engine in main, which calls
// lapseToGhost() — so once lapsed, tier is 'ghost' and this reads false.
function isMember() { return tierNow() !== 'ghost' || speakerNow(); }
function visibleNow() { return isMember() && _visible; }
// The event this identity currently holds a ticket/pass for (speaker pass wins if both).
function heldEventId() { return activePubkey ? (_speakerEventId || _ticketEventId || null) : null; }
// Does the player hold a valid ticket OR speaker pass FOR this specific event?
function holdsForNow(eventId) {
  return !!activePubkey && ((tierNow() !== 'ghost' && _ticketEventId === eventId) || (speakerNow() && _speakerEventId === eventId));
}
// The tier's default flags + à-la-carte access + the speaker pass. Speaker mingles (networking +
// smoking) and gets a backstage SEAM flag (no zone yet). `badge` = attendee gem; `speaker` = the
// 🎙 mark — both can show (combinable) — the label renders them together (avatars.js).
function flagsNow() {
  const base = TIERS[tierNow()]?.flags || {};
  const sp = speakerNow();
  return {
    badge: base.badge || null,
    speaker: sp,
    networkingPriority: !!base.networkingPriority,
    networkingAccess: !!base.networkingAccess || _access.has('networking') || sp,
    smokingAccess: !!base.smokingAccess || _access.has('smoking') || sp,
    frontRow: !!base.frontRow || _access.has('frontRow'),
    sponsorSpot: !!base.sponsorSpot,
    backstageAccess: sp, // SEAM: speakers get backstage — no backstage zone built yet
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export const tickets = {
  TIERS,
  tier: tierNow,
  flags: flagsNow,
  visible: visibleNow,

  split: splitFor,
  speakerPot(eventId) { return _pots[eventId] || 0; }, // THIS event's speaker pot
  venueRevenue() { return _venue; },
  // Record venue revenue (stage rent, ticket fees). NEVER touches a speaker pot.
  recordVenue(sats) { addVenue(sats); },
  speakerPass: speakerNow,
  heldEventId,
  holdsFor: holdsForNow,
  // Grant the speaker pass for a specific EVENT (booking calls this on a confirmed booking).
  grantSpeakerPass(eventId) {
    if (!activePubkey) return false;
    _speaker = true; _speakerEventId = eventId || _speakerEventId; _visible = true; // a fresh speaker is embodied
    persist(); emit();
    return true;
  },
  // Lapse to ghost — event ended + grace over, OR the player chose "continue as ghost". KEEPS
  // identity, wallet CREDITS (never expire), and badge-history (_prevTier); drops tier/pass +
  // their perks/access so a stale ticket can't grant zones/embodiment. Idempotent.
  lapseToGhost() {
    if (!activePubkey || (tierNow() === 'ghost' && !speakerNow())) return false;
    if (_tier !== 'ghost') _prevTier = _tier;
    _tier = 'ghost'; _ticketEventId = null; _speaker = false; _speakerEventId = null; _access = new Set();
    persist(); emit();
    return true;
  },
  prevTier() { return _prevTier; },
  // This identity's last purchase split; older records (pre-3.14) have no split → null.
  lastSplit() { return _lastSplit; },

  // Load this identity's persisted tier/embodiment/pass; make the service live for it.
  activate(pubkey) {
    activePubkey = pubkey;
    _tier = 'ghost'; _ticketEventId = null; _visible = true; _access = new Set();
    _speaker = false; _speakerEventId = null; _lastSplit = null; _prevTier = null;
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey(pubkey)) || 'null');
      if (raw && TIERS[raw.tier]) {
        _tier = raw.tier; _ticketEventId = raw.ticketEventId || null;
        _visible = raw.visible !== false; _access = new Set(raw.access || []);
        _speaker = !!raw.speaker; _speakerEventId = raw.speakerEventId || null;
        _lastSplit = raw.lastSplit || null; _prevTier = raw.prevTier || null;
        // MIGRATION: pre-3.18 records lack event ids → the transition engine treats the held
        // event as absent and re-prompts for the current event (no crash, credits intact).
      }
    } catch { /* ignore */ }
    emit();
    return snapshot();
  },
  // On logout: drop in-memory state (→ ghost). Persisted per-pubkey record + pots stay.
  deactivate() {
    activePubkey = null; _tier = 'ghost'; _ticketEventId = null; _visible = true; _access = new Set();
    _speaker = false; _speakerEventId = null; _lastSplit = null; _prevTier = null; emit();
  },

  onChange(cb) { subs.add(cb); return () => subs.delete(cb); },

  // Buy a ticket FOR AN EVENT. ENTRY PAYMENT (mock external — not from credits); on confirmed,
  // set the tier + eventId, credit the wallet, and accrue the speaker share to THAT event's pot.
  async buy(tierName, eventId) {
    if (!activePubkey) return { state: 'failed', reason: 'not signed in' };
    const t = TIERS[tierName];
    if (!t || tierName === 'ghost') return { state: 'failed', reason: 'unknown tier' };
    if (!eventId) return { state: 'failed', reason: 'no event' };

    const id = `ticket-${++seq}`;
    const sp = splitFor(tierName);
    emit();
    await delay(PENDING_MS);
    _tier = tierName;
    _ticketEventId = eventId;            // this ticket is scoped to the event
    _prevTier = _tier;
    _visible = true;
    _lastSplit = sp;
    persist();
    wallet.topUp(sp.credits);           // CREDITS land in the wallet
    growPot(eventId, sp.speakers);      // speaker share → THIS event's pot only
    emit();
    return { state: 'confirmed', id, tier: tierName, eventId, ...sp };
  },

  // Embodiment toggle for MEMBERS (paid tier OR speaker pass). No-op for true ghosts.
  setVisible(on) {
    if (!isMember()) return false;
    _visible = !!on; persist(); emit();
    return _visible;
  },

  // Micro-purchase: spend CREDITS from the wallet for an access flag. Generic over ACCESS;
  // only recognised kinds do anything. Returns { ok, reason?, price? }.
  purchaseAccess(kind) {
    if (!activePubkey) return { ok: false, reason: 'not signed in' };
    if (tierNow() === 'ghost') return { ok: false, reason: 'no ticket' };
    const a = ACCESS[kind];
    if (!a) return { ok: false, reason: 'unknown access' };
    if (flagsNow()[a.flag]) return { ok: true, already: true }; // tier or prior purchase already grants it
    const res = wallet.spend(a.price, `access:${kind}`);
    if (!res.ok) return { ok: false, reason: res.reason, price: a.price };
    _access.add(kind); persist(); emit();
    return { ok: true, price: a.price };
  },
  accessPrice(kind) { return ACCESS[kind]?.price ?? null; },
};
