// ui/speakerHub.js — the booked speaker's home. Unlocked only when you hold a booking
// (gated in the Stage menu). SLICE 3.5: a shell showing your booked slot. SLICE 3.6
// fills in Cancel booking + the mic-queue control (criteria toggle + list + pick/next).
//
//   createSpeakerHub({ toast })
//     open({ mySlot }) · close() · isOpen()

const $ = (id) => document.getElementById(id);

export function createSpeakerHub({ toast } = {}) {
  const el = {
    root: $('speaker-hub'),
    slot: $('hub-slot'),
    close: $('hub-close'),
  };

  function render({ mySlot } = {}) {
    el.slot.innerHTML = mySlot
      ? `<div class="hub-slot-time">${fmtTime(mySlot.startsAt)}</div><div class="hub-slot-title">${escapeText(mySlot.title || 'Untitled talk')}</div>`
      : '<div class="muted">No booking.</div>';
  }

  function open(data) { render(data); el.root.hidden = false; }
  function close() { el.root.hidden = true; }

  el.close.addEventListener('click', close);
  el.root.addEventListener('click', (e) => { if (e.target === el.root) close(); });

  return { open, render, close, isOpen: () => !el.root.hidden };
}

function fmtTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function escapeText(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
