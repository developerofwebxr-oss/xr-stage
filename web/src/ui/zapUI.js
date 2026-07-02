// ui/zapUI.js — the flat/mobile zap surfaces: the SPEND-MENU HUB and the AMOUNT
// PICKER. Container only; all balance/payment logic lives in the wallet service, and
// the recipient comes from the identity service — this module just collects intent.
//
//   createZapUI({ onConnect, onZapSomeone, onPickAmount })
//     openHub({ connected, balance })   spend hub — home for sats actions
//     closeHub()
//     openPicker({ pubkey, name })      amount picker for one recipient
//     closePicker()
//     closeAll() · isOpen()
//
// The hub lists the ONE live action (zap someone) plus disabled "coming soon" entries
// for features that don't exist yet (zap-to-comment, zap-to-request) — structure now,
// no faked behaviour. The picker's presets + custom field resolve to onPickAmount(
// pubkey, sats); VR skips the picker entirely (the Y binding quick-zaps a default).

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');

export function createZapUI({ onConnect, onZapSomeone, onPickAmount } = {}) {
  const el = {
    hub: $('spend-menu'),
    hubWallet: $('spend-wallet'),
    spZapSomeone: $('sp-zap-someone'),
    picker: $('zap-picker'),
    pName: $('zp-name'),
    pClose: $('zp-close'),
    pCancel: $('zp-cancel'),
    pSend: $('zp-send'),
    pAmount: $('zp-amount'),
    pPresets: $('zp-presets'),
  };
  let recipient = null; // { pubkey, name } while the picker is open

  // ── Spend hub ─────────────────────────────────────────────────────────────────
  function renderWallet({ connected, balance }) {
    el.hubWallet.innerHTML = '';
    if (connected) {
      const line = document.createElement('div');
      line.innerHTML = `⚡ Balance: <b>${fmt(balance)}</b> sats`;
      el.hubWallet.appendChild(line);
    } else {
      const btn = document.createElement('button');
      btn.className = 'ctl primary';
      btn.id = 'sp-connect';
      btn.textContent = 'Connect wallet';
      btn.addEventListener('click', () => onConnect && onConnect());
      el.hubWallet.appendChild(btn);
    }
  }
  function openHub(state) { renderWallet(state); el.hub.hidden = false; }
  function closeHub() { el.hub.hidden = true; }

  el.hub.addEventListener('click', (e) => { if (e.target === el.hub) closeHub(); }); // backdrop
  el.spZapSomeone.addEventListener('click', () => onZapSomeone && onZapSomeone());

  // ── Amount picker (flat/mobile only) ────────────────────────────────────────────
  function setAmount(v) {
    el.pAmount.value = String(v);
    for (const b of el.pPresets.querySelectorAll('.zp-preset')) {
      b.classList.toggle('sel', Number(b.dataset.amt) === Number(v));
    }
  }
  function openPicker({ pubkey, name } = {}) {
    recipient = { pubkey, name };
    el.pName.textContent = name || 'someone';
    setAmount(21); // default preset
    el.picker.hidden = false;
    el.pSend.focus?.();
  }
  function closePicker() { recipient = null; el.picker.hidden = true; }

  el.pPresets.addEventListener('click', (e) => {
    const b = e.target.closest('.zp-preset');
    if (b) setAmount(Number(b.dataset.amt));
  });
  el.pAmount.addEventListener('input', () => setAmount(el.pAmount.value)); // clears preset highlight if custom
  el.pClose.addEventListener('click', closePicker);
  el.pCancel.addEventListener('click', closePicker);
  el.picker.addEventListener('click', (e) => { if (e.target === el.picker) closePicker(); }); // backdrop
  el.pSend.addEventListener('click', () => {
    const amt = Math.floor(Number(el.pAmount.value));
    const to = recipient;
    closePicker();
    if (to && amt > 0 && onPickAmount) onPickAmount(to.pubkey, amt, to.name);
  });

  return {
    openHub, closeHub, openPicker, closePicker,
    closeAll() { closeHub(); closePicker(); },
    isOpen: () => !el.hub.hidden || !el.picker.hidden,
  };
}
