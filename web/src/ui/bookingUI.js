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
    note: $('booking-note'),
    list: $('booking-slots'),
    confirm: $('booking-confirm'),
    title: $('booking-title'),
    desc: $('booking-desc'),
    len: $('booking-len'),
    book: $('booking-book'),
    close: $('booking-close'),
  };
  let selected = null;   // slotId of the free slot the user picked (event start)
  let lenSlots = 1;      // consecutive slots to book as ONE event (10/20/30 min)
  let pricePer = 10000, slotMin = 10;

  function render({ slots = [], myPubkey = null } = {}) {
    selected = null;
    el.confirm.hidden = true;
    const s0 = slots[0];
    if (s0) { pricePer = s0.price; slotMin = s0.durationMin; }
    if (s0) el.note.innerHTML = `<b>${fmt(pricePer)} sats</b> · ${slotMin} min per slot`
      + `<span class="sub">Book consecutive slots as one event. Booking includes your 🎙 Speaker pass — no ticket needed.</span>`;
    el.list.innerHTML = '';
    for (const s of slots) {
      const row = document.createElement('button');
      row.className = `slot-row${s.mine ? ' mine' : ''}${s.taken && !s.mine ? ' taken' : ''}`;
      row.disabled = !!s.taken;
      const status = s.mine ? `Yours — ${s.title || 'Untitled'}` : s.taken ? `Taken — ${s.title || ''}` : 'Free';
      row.innerHTML = `<span class="slot-time">${fmtTime(s.startsAt)}</span>`
        + `<span class="slot-price">${fmt(s.price)} sats</span>`
        + `<span class="slot-status">${status}</span>`;
      if (!s.taken) row.addEventListener('click', () => select(s.id, row));
      el.list.appendChild(row);
    }
  }

  function select(slotId, row) {
    selected = slotId;
    for (const r of el.list.querySelectorAll('.slot-row')) r.classList.remove('sel');
    row.classList.add('sel');
    setLen(1);
    el.confirm.hidden = false;
    el.title.value = '';
    if (el.desc) el.desc.value = '';
    el.title.focus();
    updateBookLabel();
  }
  function setLen(n) {
    lenSlots = n;
    for (const b of el.len.querySelectorAll('.len-btn')) b.classList.toggle('active', Number(b.dataset.slots) === n);
    updateBookLabel();
  }
  function updateBookLabel() {
    el.book.textContent = `Book ${lenSlots * slotMin} min · ${fmt(lenSlots * pricePer)} sats ⚡`;
  }

  function open(data) { render(data); el.root.hidden = false; }
  function close() { el.root.hidden = true; }

  el.close.addEventListener('click', close);
  el.root.addEventListener('click', (e) => { if (e.target === el.root) close(); });
  el.len.addEventListener('click', (e) => { const b = e.target.closest('.len-btn'); if (b) setLen(Number(b.dataset.slots)); });
  el.book.addEventListener('click', () => {
    if (!selected) return toast && toast('Pick a free slot first');
    onBook && onBook(selected, el.title.value.trim(), lenSlots, el.desc ? el.desc.value.trim() : '');
  });

  return { open, render, close, isOpen: () => !el.root.hidden };
}

function fmtTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
