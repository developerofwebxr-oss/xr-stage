import { wallet } from '../wallet/wallet.js';

// tickets/tickets.js — the ONE source of TIER + EMBODIMENT state. The venue's business model:
// free visitors are GHOSTS (listen only, no body); a one-time paid TICKET per identity buys
// embodiment + venue CREDITS + perks. MOCK now, but the seam matches the real thing.
//
//   tier()              → 'ghost' | 'basic' | 'supporter' | 'patron'
//   buy(tier) async     → pending→confirmed|failed; on confirmed sets tier + credits the wallet
//   split(tier)         → { price, venue, speakers, credits } — the transparent per-tier math
//   flags()             → { badge, networkingPriority, networkingAccess, smokingAccess, frontRow, sponsorSpot }
//   visible()/setVisible(bool) → paid-only embodiment toggle (ghosts are always invisible)
//   purchaseAccess(kind)→ micro-purchase: spend CREDITS for an access flag (networking/smoking/frontRow)
//   speakerPool()       → total sats accrued for speakers across ticket purchases (venue-global)
//   lastSplit()         → this identity's last purchase split (for "where your sats went")
//   activate(pubkey)/deactivate() · onChange(cb)
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

const PERK_KEYS = ['badge', 'networkingPriority', 'networkingAccess', 'smokingAccess', 'frontRow', 'sponsorSpot'];

let activePubkey = null;
let _tier = 'ghost';
let _visible = true;              // embodied by default once paid (ghosts ignore this)
let _access = new Set();          // extra access kinds bought à la carte (Basic)
let _lastSplit = null;            // this identity's most recent purchase split (persisted)
let seq = 0;
const subs = new Set();
const emit = () => { for (const cb of subs) cb(snapshot()); };

const storeKey = (pk) => `xrstage:ticket:${pk}`;
function persist() {
  if (!activePubkey) return;
  try { localStorage.setItem(storeKey(activePubkey), JSON.stringify({ tier: _tier, visible: _visible, access: [..._access], lastSplit: _lastSplit })); }
  catch { /* private mode */ }
}

// Speaker pool — ONE venue-global pot (not per-pubkey). Persisted across sessions; every ticket
// purchase grows it by that tier's speaker share (see the distribution seam note at the top).
const POOL_KEY = 'xrstage:speakerPool';
function loadPool() { try { return Number(localStorage.getItem(POOL_KEY)) || 0; } catch { return 0; } }
let _pool = loadPool();
function growPool(sats) {
  if (!sats) return;
  _pool += sats;
  try { localStorage.setItem(POOL_KEY, String(_pool)); } catch { /* private mode */ }
}

function snapshot() { return { tier: tierNow(), flags: flagsNow(), visible: visibleNow(), speakerPool: _pool }; }

function tierNow() { return activePubkey ? _tier : 'ghost'; }
function visibleNow() { return tierNow() !== 'ghost' && _visible; }
// Merge the tier's default flags with any à-la-carte access bought with credits.
function flagsNow() {
  const base = TIERS[tierNow()]?.flags || {};
  const out = { badge: base.badge || null };
  for (const k of PERK_KEYS) if (k !== 'badge') out[k] = !!base[k];
  for (const kind of _access) { const f = ACCESS[kind]?.flag; if (f) out[f] = true; }
  return out;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export const tickets = {
  TIERS,
  tier: tierNow,
  flags: flagsNow,
  visible: visibleNow,

  split: splitFor,
  speakerPool() { return _pool; },
  // This identity's last purchase split; older records (pre-3.14) have no split → null.
  lastSplit() { return _lastSplit; },

  // Load this identity's persisted tier/embodiment; make the service live for it.
  activate(pubkey) {
    activePubkey = pubkey;
    _tier = 'ghost'; _visible = true; _access = new Set(); _lastSplit = null;
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey(pubkey)) || 'null');
      if (raw && TIERS[raw.tier]) {
        _tier = raw.tier; _visible = raw.visible !== false; _access = new Set(raw.access || []);
        _lastSplit = raw.lastSplit || null; // MIGRATION: old records lack this — fine, stays null
      }
    } catch { /* ignore */ }
    emit();
    return snapshot();
  },
  // On logout: drop in-memory state (→ ghost). Persisted per-pubkey record + pool stay.
  deactivate() { activePubkey = null; _tier = 'ghost'; _visible = true; _access = new Set(); _lastSplit = null; emit(); },

  onChange(cb) { subs.add(cb); return () => subs.delete(cb); },

  // Buy a ticket. ENTRY PAYMENT (mock external — NOT from local credits); on confirmed, set
  // the tier and credit the wallet with the post-fee amount. pending → confirmed | failed.
  async buy(tierName) {
    if (!activePubkey) return { state: 'failed', reason: 'not signed in' };
    const t = TIERS[tierName];
    if (!t || tierName === 'ghost') return { state: 'failed', reason: 'unknown tier' };

    const id = `ticket-${++seq}`;
    const sp = splitFor(tierName);      // { price, venue, speakers, credits }
    emit(); // (no visual state change yet; a caller can show its own pending UI)
    await delay(PENDING_MS);            // simulate the external payment settling
    // MOCK: the external payment always confirms. REAL: await the Lightning invoice settle.
    _tier = tierName;
    _visible = true;                    // embodied on purchase
    _lastSplit = sp;                    // remember the split for "where your sats went"
    persist();
    wallet.topUp(sp.credits);           // CREDITS (price − venue − speakers) land in the wallet
    growPool(sp.speakers);              // the speaker share accrues to the venue-global pool
    emit();                             // fires onChange listeners (tier + pool growth)
    return { state: 'confirmed', id, tier: tierName, ...sp };
  },

  // Paid-only embodiment toggle. Ghosts can't embody, so this is a no-op for them.
  setVisible(on) {
    if (tierNow() === 'ghost') return false;
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
