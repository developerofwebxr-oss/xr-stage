// ui/zapUI.js — the ROOM-level spend hub + the flat/mobile amount picker. Container
// only; balance/payment logic lives in the wallet service and the recipient comes from
// identity. Person-zapping is the profile card's job — the hub is room actions only:
//
//   Zap the speaker — live when someone's on stage, dimmed (toast) when empty.
//   Zap to comment  — dimmed (→ future board), toast on tap.
//   Take the mic    — dimmed (→ future questioner queue), toast on tap.
//
//   createZapUI({ toast, onZapSpeaker, onPickAmount })
//     openHub({ speakerAvailable })   spend hub
//     closeHub()
//     openPicker({ pubkey, name })    amount picker for one recipient
//     closePicker()
//     closeAll() · isOpen()

const $ = (id) => document.getElementById(id);
const NOT_YET = 'Not available yet';

export function createZapUI({ toast, onZapSpeaker, onPickAmount } = {}) {
  const el = {
    hub: $('spend-menu'),
    spZapSpeaker: $('sp-zap-speaker'),
    spZapComment: $('sp-zap-comment'),
    spTakeMic: $('sp-take-mic'),
    spClose: $('spend-close'),
    picker: $('zap-picker'),
    pName: $('zp-name'),
    pClose: $('zp-close'),
    pCancel: $('zp-cancel'),
    pSend: $('zp-send'),
    pAmount: $('zp-amount'),
    pPresets: $('zp-presets'),
  };
  let recipient = null;         // { pubkey, name } while the picker is open
  let speakerAvailable = false; // gate for "Zap the speaker"
  const dim = (msg = NOT_YET) => toast && toast(msg);

  // ── Spend hub (room actions) ────────────────────────────────────────────────────
  function openHub({ speakerAvailable: avail = false } = {}) {
    speakerAvailable = avail;
    el.spZapSpeaker.classList.toggle('soon', !avail);
    el.spZapSpeaker.setAttribute('aria-disabled', String(!avail));
    el.hub.hidden = false;
  }
  function closeHub() { el.hub.hidden = true; }

  el.spClose.addEventListener('click', closeHub);
  el.hub.addEventListener('click', (e) => { if (e.target === el.hub) closeHub(); }); // backdrop
  el.spZapSpeaker.addEventListener('click', () => {
    if (!speakerAvailable) return dim('No one on stage to zap');
    onZapSpeaker && onZapSpeaker(); // hub stays open; the picker opens over it
  });
  el.spZapComment.addEventListener('click', () => dim()); // → future comment board
  el.spTakeMic.addEventListener('click', () => dim());    // → future questioner queue

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
    setAmount(21);
    closeHub();                // the picker replaces the hub
    el.picker.hidden = false;
    el.pSend.focus?.();
  }
  function closePicker() { recipient = null; el.picker.hidden = true; }

  el.pPresets.addEventListener('click', (e) => {
    const b = e.target.closest('.zp-preset');
    if (b) setAmount(Number(b.dataset.amt));
  });
  el.pAmount.addEventListener('input', () => setAmount(el.pAmount.value)); // custom clears preset highlight
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
