import { identity } from '../identity/identity.js';

// wallet/wallet.js — the ONE source of balance + zaps. It is a MOCK now (no real
// Lightning), but its surface matches the real shapes (NWC / WebLN + NIP-57 zaps) so
// the real implementation swaps in behind it without touching a single caller:
//
//   connect()      async → { balance }   (real: NWC connection string / WebLN enable)
//   getBalance()   → sats (number)
//   zap({ toPubkey, amountSats, note }) async → resolves through pending→confirmed|failed
//   onZap(cb)      → subscribe to zap events (real: kind:9735 zap receipts); returns unsub
//   disconnect() · isConnected()
//
// Swap rules baked in (followed exactly):
//  • zap is ASYNC and moves through pending → confirmed | failed (real invoices have
//    latency and can fail — the UI must handle the wait AND the failure).
//  • zap is keyed by recipient pubkey + amountSats + optional note (NIP-57 shape).
//  • zap reads the recipient's lud16 via identity.getProfile(toPubkey) BEFORE paying —
//    the mock ignores the value, but real zaps fetch a bolt11 invoice from that
//    Lightning address, so the plumbing must already be here.
//  • balance decrements ONLY on `confirmed`; insufficient balance → `failed`.
//  • the wallet is SEPARATE from identity (signing ≠ paying); it only READS recipient
//    data through the identity service — it never signs or holds keys.

const MOCK_BALANCE = 21000;   // sats granted on connect (real: fetched from the wallet)
const PENDING_MS = 1000;      // simulated invoice latency (deterministic, no randomness)

let connected = false;
let balance = 0;
let seq = 0;
const subs = new Set();
const emit = (evt) => { for (const cb of subs) cb(evt); };

export const wallet = {
  // REAL: open the NWC connection / WebLN.enable() and read the live balance.
  async connect() {
    connected = true;
    balance = MOCK_BALANCE;
    return { balance };
  },
  disconnect() { connected = false; balance = 0; },
  isConnected() { return connected; },
  getBalance() { return balance; },

  // Any zap event (pending/confirmed/failed) for feedback + tallies. REAL: this is fed
  // by kind:9735 zap receipts observed on relays.
  onZap(cb) { subs.add(cb); return () => subs.delete(cb); },

  // Pay a person. Resolves to the FINAL event ({ state:'confirmed'|'failed', … });
  // intermediate `pending` is delivered via onZap so the UI can show the wait.
  async zap({ toPubkey, amountSats, note } = {}) {
    if (!connected) throw new Error('wallet not connected');
    const id = `zap-${++seq}`;
    const base = { id, toPubkey, amountSats, note: note || null };

    // Real zaps need the recipient's Lightning address to fetch an invoice; read it
    // through the identity service now so the shape matches (mock ignores lud16).
    const profile = await identity.getProfile(toPubkey);
    const lud16 = profile?.lud16 || null;           // REAL: LNURL-pay(lud16) → bolt11 → pay

    emit({ ...base, lud16, state: 'pending' });
    await delay(PENDING_MS);                         // REAL: awaiting the payment to settle

    if (!Number.isFinite(amountSats) || amountSats <= 0) {
      const evt = { ...base, state: 'failed', reason: 'invalid amount' };
      emit(evt); return evt;
    }
    if (amountSats > balance) {
      const evt = { ...base, state: 'failed', reason: 'insufficient balance' };
      emit(evt); return evt;
    }
    balance -= amountSats;                           // decrement ONLY on success
    const evt = { ...base, state: 'confirmed', balance };
    emit(evt); return evt;
  },
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
