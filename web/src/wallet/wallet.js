import { identity } from '../identity/identity.js';

// wallet/wallet.js — the ONE source of balance + zaps. The wallet is a LOCAL VENUE
// BALANCE tied to your identity (NOT an external wallet connection): you top it up here,
// spend it here, and it's persisted PER PUBKEY. It stays a MOCK, but the seam matches the
// real thing — real top-up later = pay a Lightning invoice that credits this balance;
// the interface below doesn't change.
//
//   activate(pubkey)  → load that identity's persisted balance and make the wallet live
//   deactivate()      → clear in-memory state (on logout; the persisted balance stays)
//   isConnected()     → is a wallet active for the signed-in identity?
//   getBalance()      → sats (number; 0 when inactive)
//   topUp(amountSats) → credit the local balance (real: pay an invoice to top up), persists
//   zap({ toPubkey, amountSats, note }) async → pending → confirmed | failed; persists
//   onZap(cb)         → subscribe to zap events (real: kind:9735 receipts); returns unsub
//
// Swap rules baked in: zap is ASYNC (pending→confirmed|failed); keyed by recipient pubkey
// + amount + optional note (NIP-57); reads the recipient's lud16 via identity BEFORE
// paying (real: LNURL-pay → bolt11); balance decrements ONLY on confirmed; insufficient →
// failed. The wallet is SEPARATE from identity (signing ≠ paying) — it only reads
// recipient data and keys its balance by pubkey; it never signs or holds keys.

export const DEFAULT_TOPUP = 21000; // sats added per mock top-up (real: invoice amount)
const PENDING_MS = 1000;            // simulated settle latency (deterministic)

let activePubkey = null; // the signed-in identity this wallet belongs to
let balance = 0;
let seq = 0;
const subs = new Set();
const emit = (evt) => { for (const cb of subs) cb(evt); };

const storeKey = (pk) => `xrstage:wallet:${pk}`;
function loadBalance(pk) {
  try { return Number(localStorage.getItem(storeKey(pk))) || 0; } catch { return 0; }
}
function persist() {
  if (!activePubkey) return;
  try { localStorage.setItem(storeKey(activePubkey), String(balance)); } catch { /* private mode */ }
}

export const wallet = {
  DEFAULT_TOPUP,

  // Make the wallet live for a signed-in identity, restoring its persisted balance.
  activate(pubkey) {
    activePubkey = pubkey;
    balance = loadBalance(pubkey);
    return { balance };
  },
  // On logout: drop in-memory state. The persisted per-pubkey balance is untouched.
  deactivate() { activePubkey = null; balance = 0; },
  isConnected() { return activePubkey !== null; },
  getBalance() { return balance; },

  // Credit the local balance. MOCK: add a fixed amount. REAL: pay a Lightning invoice to
  // this venue and credit the settled amount — same call site.
  topUp(amountSats = DEFAULT_TOPUP) {
    if (!activePubkey) return { ok: false, reason: 'not signed in' };
    balance += amountSats;
    persist();
    return { ok: true, balance };
  },

  // Spend credits to the VENUE (a distinct spend TYPE from a person-to-person zap): the
  // micro-purchase path — buying access/experiences with your local credit balance. Instant
  // (no invoice; it's internal venue credit), debits + persists. REAL: still internal credit.
  spend(amountSats, memo = '') {
    if (!activePubkey) return { ok: false, reason: 'not signed in' };
    if (!Number.isFinite(amountSats) || amountSats <= 0) return { ok: false, reason: 'invalid amount' };
    if (amountSats > balance) return { ok: false, reason: 'insufficient balance' };
    balance -= amountSats;
    persist();
    emit({ id: `spend-${++seq}`, memo, amountSats, state: 'spent', balance });
    return { ok: true, balance };
  },

  onZap(cb) { subs.add(cb); return () => subs.delete(cb); },

  async zap({ toPubkey, amountSats, note } = {}) {
    if (!activePubkey) throw new Error('wallet not active');
    const id = `zap-${++seq}`;
    const base = { id, toPubkey, amountSats, note: note || null };

    // Real zaps fetch the recipient's invoice from their Lightning address; read it now.
    const profile = await identity.getProfile(toPubkey);
    const lud16 = profile?.lud16 || null;

    emit({ ...base, lud16, state: 'pending' });
    await delay(PENDING_MS);

    if (!Number.isFinite(amountSats) || amountSats <= 0) {
      const evt = { ...base, state: 'failed', reason: 'invalid amount' };
      emit(evt); return evt;
    }
    if (amountSats > balance) {
      const evt = { ...base, state: 'failed', reason: 'insufficient balance' };
      emit(evt); return evt;
    }
    balance -= amountSats;   // decrement ONLY on success
    persist();               // spend persists as it happens
    const evt = { ...base, state: 'confirmed', balance };
    emit(evt); return evt;
  },
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
