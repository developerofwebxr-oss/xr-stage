// ui/ticketUI.js — the ticket chooser (three paid tiers) + the access micro-purchase confirm.
// Container only: prices/credits come from the tickets catalogue; buying/effects are injected.
//
//   createTicketUI({ toast, tiers, split, currentTier, getBalance, onBuy, onAccess })
//     openChooser() · closeChooser()
//     openAccess({ kind, label, price }) · closeAccess()
//     closeAll() · isOpen()

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');

// Honest, compact perk lists per tier (the split line is rendered separately). The speaker
// share is framed positively as its own perk line.
const PERKS = {
  basic:     ['Embodied — others see you', '10% supports the speakers', 'Buy zone access with credits'],
  supporter: ['Name badge', '20% to the speakers', 'Networking + Smoking access', 'Networking priority'],
  patron:    ['Distinct badge · all Supporter perks', '30% to the speakers — patron of the event', 'Front-row access', '🦩 Nostrich Park entry included', 'Sponsor-ticker spot'],
};
const ORDER = ['basic', 'supporter', 'patron'];
const KIND_LABEL = { networking: 'Networking', smoking: 'Smoking Area', frontRow: 'Front row' };

export function createTicketUI({ toast, tiers, split, currentTier, getBalance, onBuy, onAccess } = {}) {
  const el = {
    menu: $('ticket-menu'), tiersBox: $('ticket-tiers'), close: $('ticket-close'), event: $('ticket-event'),
    access: $('access-menu'), aTitle: $('access-title'), aBody: $('access-body'),
    aConfirm: $('access-confirm'), aCancel: $('access-cancel'), aClose: $('access-close'),
  };
  let busy = false, pendingAccess = null;
  let prices = null, custom = false;   // per-event price overrides (4.7) + whether they differ from defaults

  // ── Tier chooser ────────────────────────────────────────────────────────────────
  // `eventTitle` scopes the chooser to the event; `prices` = the event's tier table (organizer
  // override), `custom` = it differs from the venue defaults → shown as an honesty note.
  function openChooser({ eventTitle, prices: pr = null, custom: cus = false } = {}) {
    prices = pr; custom = cus;
    const head = eventTitle ? `🎟 Tickets for: ${eventTitle}` : "You're a ghost — a ticket embodies you + adds credits.";
    el.event.innerHTML = head + (custom ? '<span class="sub" style="display:block;color:var(--ink-dim);font-size:12px">Prices set by the organizer.</span>' : '');
    render(); el.menu.hidden = false;
  }
  function closeChooser() { el.menu.hidden = true; }
  const priceOf = (id) => (prices && prices[id]) || tiers[id].price;

  function render() {
    const cur = currentTier();
    el.tiersBox.innerHTML = '';
    for (const id of ORDER) {
      const t = tiers[id];
      const s = split(id, priceOf(id)); // { price, venue, speakers, credits } from the EVENT's price
      const card = document.createElement('div');
      card.className = `tier ${id}`;
      const perks = PERKS[id].map((p) => `<li>${p}</li>`).join('');
      const isCurrent = cur === id;
      card.innerHTML =
        `<div class="tier-head"><span class="tier-name">${t.label}</span>` +
        `<span class="tier-price">${fmt(priceOf(id))} sats</span></div>` +
        `<div class="tier-credits">→ <b>${fmt(s.credits)} credits</b> · <span class="fee">⚡${fmt(s.venue)} venue</span> · <span class="spk">⚡${fmt(s.speakers)} to speakers</span></div>` +
        `<ul class="tier-perks">${perks}</ul>` +
        `<button class="ctl ${id === 'ghost' ? '' : 'primary'}" data-tier="${id}" ${isCurrent ? 'disabled' : ''}>${isCurrent ? 'Current plan' : `Get ${t.label} ⚡`}</button>`;
      el.tiersBox.appendChild(card);
    }
    el.tiersBox.querySelectorAll('button[data-tier]').forEach((b) => b.addEventListener('click', () => buy(b.dataset.tier, b)));
  }

  async function buy(tier, btn) {
    if (busy) return;
    busy = true;
    const label = btn.textContent;
    btn.textContent = 'Buying…'; btn.disabled = true;
    try {
      const res = await onBuy(tier); // → { state, credits, ... }
      if (res?.state === 'confirmed') { closeChooser(); }        // main toasts + re-embodies via tickets.onChange
      else { toast && toast(`Purchase failed — ${res?.reason || 'try again'}`); btn.textContent = label; btn.disabled = false; }
    } catch { toast && toast('Purchase failed — try again'); btn.textContent = label; btn.disabled = false; }
    finally { busy = false; }
  }

  // ── Access micro-purchase ─────────────────────────────────────────────────────────
  function openAccess({ kind, price }) {
    pendingAccess = kind;
    el.aTitle.textContent = `Buy ${KIND_LABEL[kind] || kind} access`;
    el.aBody.innerHTML = `Spend <b>${fmt(price)} credits</b> for <b>${KIND_LABEL[kind] || kind}</b> access. Your balance: <b>${fmt(getBalance())} credits</b>.`;
    el.access.hidden = false;
  }
  function closeAccess() { el.access.hidden = true; pendingAccess = null; }

  async function confirmAccess() {
    if (busy || !pendingAccess) return;
    busy = true; el.aConfirm.disabled = true;
    const kind = pendingAccess;
    try {
      const res = await onAccess(kind); // main performs tickets.purchaseAccess + effects
      if (res?.ok) closeAccess();
      else toast && toast(res?.reason === 'insufficient balance' ? 'Not enough credits' : 'Could not buy access');
    } finally { busy = false; el.aConfirm.disabled = false; }
  }

  el.close.addEventListener('click', closeChooser);
  el.menu.addEventListener('click', (e) => { if (e.target === el.menu) closeChooser(); });
  el.aConfirm.addEventListener('click', confirmAccess);
  el.aCancel.addEventListener('click', closeAccess);
  el.aClose.addEventListener('click', closeAccess);
  el.access.addEventListener('click', (e) => { if (e.target === el.access) closeAccess(); });

  return {
    openChooser, closeChooser, openAccess, closeAccess,
    closeAll() { closeChooser(); closeAccess(); },
    isOpen: () => !el.menu.hidden || !el.access.hidden,
  };
}
