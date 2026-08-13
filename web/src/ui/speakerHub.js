import { drawKeyface } from '../identity/keyface.js';

// ui/speakerHub.js — the booked speaker's home (unlocked only with a booking). v1:
//   1. My slot (time, title) + Cancel booking (frees the slot, NO refund, inline confirm)
//   2. Mic-queue control — criteria toggle (Money · Activity · Manual → queue.setCriteria),
//      the ranked entrant list (keyface · name · ⚡total · pitch), a per-entry "Pick" in
//      Manual mode (→ queue.next(pubkey)), and "Next questioner" (→ queue.next()).
//   NOT in scope: actual voice-role promotion at the pedestal — the cue only.
//
//   createSpeakerHub({ toast, onCancelBooking, onSetCriteria, onPick, onNext })
//     open({ mySlot, entries, criteria }) · setQueue({ entries, criteria })
//     close() · isOpen()
//   entries = [{ pubkey, name, totalSats, pitch }]

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const CRITERIA = [['money', 'Money'], ['activity', 'Activity'], ['manual', 'Manual']];

export function createSpeakerHub({ toast, onCancelBooking, onSetCriteria, onPick, onNext, onAddCoSpeaker, onEditEvent, onSetPrices } = {}) {
  const el = {
    root: $('speaker-hub'), pool: $('hub-pool'), earn: $('hub-earnings'), slot: $('hub-slot'), cancel: $('hub-cancel'),
    edit: $('hub-edit'), prices: $('hub-prices'),
    criteria: $('hub-criteria'), queue: $('hub-queue'), next: $('hub-next'), close: $('hub-close'),
    addCoSpeaker: $('hub-add-cospeaker'),
  };
  el.addCoSpeaker?.addEventListener('click', () => onAddCoSpeaker && onAddCoSpeaker());
  let mySlot = null;
  let criteria = 'money';
  let event = null, isOwner = false, defaults = { basic: 2100, supporter: 10000, patron: 21000 };

  // data: { mySlot, entries, criteria, event, isOwner, earnings:{ pot, zaps, yourMin, totalMin }, defaults }
  function open(data = {}) {
    mySlot = data.mySlot || null;
    criteria = data.criteria || 'money';
    event = data.event || mySlot || null;
    isOwner = !!data.isOwner;
    defaults = data.defaults || defaults;
    el.pool.innerHTML = `<span class="pass">🎙 Speaker pass · active</span>`;
    renderEarnings(data.earnings || {});
    renderSlot();
    renderCancel(false);
    renderEdit();
    renderPrices();
    renderCriteria();
    renderQueue(data.entries || []);
    el.root.hidden = false;
  }

  // The "speaking here pays" surface: this event's pot + your direct zaps + your share basis.
  function renderEarnings({ pot = 0, zaps = 0, yourMin = 0, totalMin = 0 } = {}) {
    const nSpk = event?.speakers?.length || 1;
    el.earn.innerHTML =
      `<div class="earn-row"><span class="earn-lbl">This event's speaker pot</span><span class="earn-big">⚡ ${fmt(pot)}</span></div>`
      + `<div class="earn-row"><span class="earn-lbl">Direct zaps to you</span><span class="earn-big">⚡ ${fmt(zaps)}</span></div>`
      + `<div class="earn-sub">Pot split by stage time at payout — you: <b>${yourMin}</b> of ${totalMin} min${nSpk > 1 ? ` (equal split across ${nSpk} speakers)` : ''}.</div>`;
  }

  // Edit title + description — organizer only (co-speakers read-only v1).
  function renderEdit() {
    el.edit.innerHTML = '';
    if (!event) return;
    if (!isOwner) {
      if (event.description) { const d = document.createElement('div'); d.className = 'hub-note'; d.textContent = event.description; el.edit.appendChild(d); }
      return;
    }
    const sec = document.createElement('div'); sec.className = 'pm-section'; sec.textContent = 'My event · edit'; el.edit.appendChild(sec);
    const title = document.createElement('input'); title.type = 'text'; title.maxLength = 60; title.placeholder = 'Talk title'; title.value = event.title || '';
    const desc = document.createElement('textarea'); desc.maxLength = 280; desc.placeholder = 'Description (up to 280 chars)'; desc.value = event.description || '';
    const save = btn('Save title + description', 'ctl', () => onEditEvent && onEditEvent({ title: title.value.trim(), description: desc.value.trim() }));
    el.edit.append(title, desc, save);
  }

  // Per-event ticket prices — organizer only. Prefilled with the event's prices or the global
  // defaults; constraints (min/max, ordering) enforced in the service on save.
  function renderPrices() {
    el.prices.innerHTML = '';
    if (!event || !isOwner) return;
    const sec = document.createElement('div'); sec.className = 'pm-section'; sec.textContent = 'Ticket prices · this event'; el.prices.appendChild(sec);
    const cur = event.prices || defaults;
    const inputs = {};
    for (const [tier, label] of [['basic', 'Basic'], ['supporter', 'Supporter'], ['patron', 'Patron']]) {
      const row = document.createElement('div'); row.className = 'price-row';
      const lab = document.createElement('label'); lab.textContent = label;
      const inp = document.createElement('input'); inp.type = 'number'; inp.min = 500; inp.max = 210000; inp.step = 100; inp.value = cur[tier];
      inputs[tier] = inp; row.append(lab, inp); el.prices.appendChild(row);
    }
    const custom = !!event.prices;
    const note = document.createElement('div'); note.className = 'hub-note';
    note.textContent = custom ? 'Custom prices set — buyers see "prices set by the organizer".' : 'Using the venue defaults (2,100 / 10,000 / 21,000).';
    el.prices.appendChild(note);
    el.prices.append(
      btn('Save prices', 'ctl', () => onSetPrices && onSetPrices({ basic: +inputs.basic.value, supporter: +inputs.supporter.value, patron: +inputs.patron.value })),
      btn('Reset to defaults', 'ctl', () => onSetPrices && onSetPrices(null)),
    );
  }
  function close() { el.root.hidden = true; }
  // Live-update the ordering toggle + list while open (queue.onChange).
  function setQueue({ entries = [], criteria: crit } = {}) {
    if (el.root.hidden) return;
    if (crit) criteria = crit;
    renderCriteria();
    renderQueue(entries);
  }

  function renderSlot() {
    el.slot.innerHTML = mySlot
      ? `<div class="hub-slot-time">${fmtTime(mySlot.startsAt)}</div><div class="hub-slot-title"></div>`
      : '<div class="muted">No booking.</div>';
    if (mySlot) el.slot.querySelector('.hub-slot-title').textContent = mySlot.title || 'Untitled talk';
  }

  // Cancel booking with an inline two-step confirm (no refund).
  function renderCancel(confirming) {
    el.cancel.innerHTML = '';
    if (!mySlot) return;
    if (!confirming) {
      el.cancel.appendChild(btn('Cancel booking', 'ctl', () => renderCancel(true)));
    } else {
      el.cancel.appendChild(btn('Confirm — no refund', 'ctl danger', () => onCancelBooking && onCancelBooking(mySlot.id)));
      el.cancel.appendChild(btn('Keep', 'ctl', () => renderCancel(false)));
    }
  }

  function renderCriteria() {
    el.criteria.innerHTML = '';
    for (const [value, label] of CRITERIA) {
      const b = document.createElement('button');
      b.className = `crit${value === criteria ? ' active' : ''}`;
      b.textContent = label;
      b.addEventListener('click', () => onSetCriteria && onSetCriteria(value));
      el.criteria.appendChild(b);
    }
  }

  function renderQueue(entries) {
    el.queue.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'hub-empty';
      empty.textContent = 'No one in the mic queue.';
      el.queue.appendChild(empty);
      return;
    }
    entries.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'hub-entry';
      const face = drawKeyface(e.pubkey, 60).toDataURL();
      row.innerHTML = `<img class="he-face" src="${face}" alt="">`
        + `<div class="he-meta"><div class="he-name"></div>${e.pitch ? '<div class="he-pitch"></div>' : ''}</div>`
        + `<span class="he-sats">⚡ ${fmt(e.totalSats)}</span>`;
      row.querySelector('.he-name').textContent = `${i + 1}. ${e.name}`;
      if (e.pitch) row.querySelector('.he-pitch').textContent = e.pitch;
      // Manual mode: each entry gets a "Pick" → advance THIS entrant.
      if (criteria === 'manual') {
        row.appendChild(btn('Pick', 'ctl he-pick', () => onPick && onPick(e.pubkey)));
      }
      el.queue.appendChild(row);
    });
  }

  el.close.addEventListener('click', close);
  el.root.addEventListener('click', (ev) => { if (ev.target === el.root) close(); });
  el.next.addEventListener('click', () => onNext && onNext());

  return { open, setQueue, close, isOpen: () => !el.root.hidden };
}

function btn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
function fmtTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
