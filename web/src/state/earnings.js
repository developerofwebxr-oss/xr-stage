// state/earnings.js — a speaker's DIRECT-ZAP tally per event (4.7). The mock wallet's onZap
// is SENDER-local (it fires only on the zapper's device — see wallet.js), so a speaker's own
// client never sees zaps others sent them. We therefore BROADCAST each confirmed zap over the
// data channel (like presence/cospeaker) and each recipient accumulates its own incoming total,
// keyed by (recipientPubkey, eventId) and mock-persisted. Pot totals come from tickets; this
// module covers only the direct zaps half of the earnings view. No payout logic.

const KEY = 'xrstage:zapEarnings';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };

export function createEarnings(voice, wallet, { getMyPubkey, getEventId }) {
  const store = load();
  const key = (pk, ev) => `${pk}:${ev}`;
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* private mode */ } };
  function add(pk, ev, sats) {
    if (!pk || !ev || !(sats > 0)) return;
    store[key(pk, ev)] = (store[key(pk, ev)] || 0) + sats;
    persist();
  }

  // Outbound: broadcast my confirmed zaps (scoped to the event they were sent during) so the
  // recipient can tally them. Also self-tally (a speaker zapping within their own event counts).
  wallet.onZap((e) => {
    if (e.state !== 'confirmed' || !e.toPubkey || !(e.amountSats > 0)) return;
    const ev = getEventId();
    voice.sendData({ t: 'zap', to: e.toPubkey, amount: e.amountSats, ev }, { reliable: true });
    if (e.toPubkey === getMyPubkey()) add(e.toPubkey, ev, e.amountSats); // zapped myself → tally locally
  });

  // Inbound: tally zaps addressed to me, under the event they were sent during.
  voice.onData((_id, msg) => {
    if (!msg || msg.t !== 'zap' || msg.to !== getMyPubkey()) return;
    add(msg.to, msg.ev || getEventId(), msg.amount);
  });

  // Direct zaps I've received during a given event.
  return { receivedFor(eventId) { const pk = getMyPubkey(); return pk && eventId ? (store[key(pk, eventId)] || 0) : 0; } };
}
