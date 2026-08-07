// ui/bookingUI.js — the Book-a-slot surface: a real list of upcoming slots (time ·
// price · free/taken/yours). Pick a free slot → enter a talk title → confirm → main
// charges via the wallet and books via the booking service. Container only.
//
//   createBookingUI({ toast, onBook })
//     open({ slots, myPubkey }) · render({ slots, myPubkey }) · close() · isOpen()

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');

export function createBookingUI({ toast, onBook } = {}) {
  const el = {
    root: $('booking'),
    list: $('booking-slots'),
    confirm: $('booking-confirm'),
    title: $('booking-title'),
    book: $('booking-book'),
    close: $('booking-close'),
  };
  let selected = null; // slotId of the free slot the user picked

  function render({ slots = [], myPubkey = null } = {}) {
    selected = null;
    el.confirm.hidden = true;
    el.list.innerHTML = '';
    for (const s of slots) {
      const mine = s.bookedBy && s.bookedBy === myPubkey;
      const taken = s.bookedBy && !mine;
      const row = document.createElement('button');
      row.className = `slot-row${mine ? ' mine' : ''}${taken ? ' taken' : ''}`;
      row.disabled = !!taken;
      const status = mine ? `Yours — ${s.title || 'Untitled'}` : taken ? 'Taken' : 'Free';
      row.innerHTML = `<span class="slot-time">${fmtTime(s.startsAt)}</span>`
        + `<span class="slot-price">${fmt(s.price)} sats</span>`
        + `<span class="slot-status">${status}</span>`;
      if (!s.bookedBy) row.addEventListener('click', () => select(s.id, row));
      el.list.appendChild(row);
    }
  }

  function select(slotId, row) {
    selected = slotId;
    for (const r of el.list.querySelectorAll('.slot-row')) r.classList.remove('sel');
    row.classList.add('sel');
    el.confirm.hidden = false;
    el.title.value = '';
    el.title.focus();
  }

  function open(data) { render(data); el.root.hidden = false; }
  function close() { el.root.hidden = true; }

  el.close.addEventListener('click', close);
  el.root.addEventListener('click', (e) => { if (e.target === el.root) close(); });
  el.book.addEventListener('click', () => {
    if (!selected) return toast && toast('Pick a free slot first');
    onBook && onBook(selected, el.title.value.trim());
  });

  return { open, render, close, isOpen: () => !el.root.hidden };
}

function fmtTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
