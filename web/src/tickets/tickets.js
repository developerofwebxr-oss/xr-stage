import { wallet } from '../wallet/wallet.js';

// tickets/tickets.js — the ONE source of TIER + EMBODIMENT state. The venue's business model:
// free visitors are GHOSTS (listen only, no body); a one-time paid TICKET per identity buys
// embodiment + venue CREDITS + perks. MOCK now, but the seam matches the real thing.
//
//   tier()              → 'ghost' | 'basic' | 'supporter' | 'patron'
//   buy(tier) async     → pending→confirmed|failed; on confirmed sets tier + credits the wallet
//   flags()             → { badge, networkingPriority, networkingAccess, smokingAccess, frontRow, sponsorSpot }
//   visible()/setVisible(bool) → paid-only embodiment toggle (ghosts are always invisible)
//   purchaseAccess(kind)→ micro-purchase: spend CREDITS for an access flag (networking/smoking/frontRow)
//   activate(pubkey)/deactivate() · onChange(cb)
//
// ── MONEY FLOW (mock, custody-free "arcade ticket" model) ──────────────────────────────
// Buying a ticket is the ENTRY PAYMENT — it does NOT come from your local credit balance.
// It's a mock "external" payment (real: a Lightning invoice you pay to the venue). On
// settle we (a) set your tier and (b) credit your WALLET with the POST-FEE credit amount.
// Example: Basic = pay 2,100 sats externally → wallet gains 1,890 credits (10% venue fee).
// Micro-purchases (purchaseAccess) are the opposite direction: they SPEND those credits back
// to the venue for access/experiences. Persisted PER PUBKEY, like the wallet.

const PENDING_MS = 1000; // simulated settle latency (deterministic; matches the wallet)

// Tier catalogue. `price` = external entry payment (sats); `credits` = post-fee credits added
// to the wallet; `flags` = the perks that tier includes by default.
export const TIERS = {
  ghost:     { label: 'Ghost',     price: 0,     credits: 0,     flags: {} },
  basic:     { label: 'Basic',     price: 2100,  credits: 1890,  flags: {} },
  supporter: { label: 'Supporter', price: 8000,  credits: 7200,
    flags: { badge: 'supporter', networkingPriority: true, networkingAccess: true, smokingAccess: true } },
  patron:    { label: 'Patron',    price: 21000, credits: 18900,
    flags: { badge: 'patron', networkingPriority: true, networkingAccess: true, smokingAccess: true, frontRow: true, sponsorSpot: true } },
};

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
let seq = 0;
const subs = new Set();
const emit = () => { for (const cb of subs) cb(snapshot()); };

const storeKey = (pk) => `xrstage:ticket:${pk}`;
function persist() {
  if (!activePubkey) return;
  try { localStorage.setItem(storeKey(activePubkey), JSON.stringify({ tier: _tier, visible: _visible, access: [..._access] })); }
  catch { /* private mode */ }
}
function snapshot() { return { tier: tierNow(), flags: flagsNow(), visible: visibleNow() }; }

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

  // Load this identity's persisted tier/embodiment; make the service live for it.
  activate(pubkey) {
    activePubkey = pubkey;
    _tier = 'ghost'; _visible = true; _access = new Set();
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey(pubkey)) || 'null');
      if (raw && TIERS[raw.tier]) { _tier = raw.tier; _visible = raw.visible !== false; _access = new Set(raw.access || []); }
    } catch { /* ignore */ }
    emit();
    return snapshot();
  },
  // On logout: drop in-memory state (→ ghost). Persisted per-pubkey record stays.
  deactivate() { activePubkey = null; _tier = 'ghost'; _visible = true; _access = new Set(); emit(); },

  onChange(cb) { subs.add(cb); return () => subs.delete(cb); },

  // Buy a ticket. ENTRY PAYMENT (mock external — NOT from local credits); on confirmed, set
  // the tier and credit the wallet with the post-fee amount. pending → confirmed | failed.
  async buy(tierName) {
    if (!activePubkey) return { state: 'failed', reason: 'not signed in' };
    const t = TIERS[tierName];
    if (!t || tierName === 'ghost') return { state: 'failed', reason: 'unknown tier' };

    const id = `ticket-${++seq}`;
    emit(); // (no visual state change yet; a caller can show its own pending UI)
    await delay(PENDING_MS);            // simulate the external payment settling
    // MOCK: the external payment always confirms. REAL: await the Lightning invoice settle.
    _tier = tierName;
    _visible = true;                    // embodied on purchase
    persist();
    wallet.topUp(t.credits);            // post-fee credits land in the local wallet balance
    emit();
    return { state: 'confirmed', id, tier: tierName, price: t.price, credits: t.credits };
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
