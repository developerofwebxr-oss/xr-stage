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

export function createSpeakerHub({ toast, onCancelBooking, onSetCriteria, onPick, onNext } = {}) {
  const el = {
    root: $('speaker-hub'), pool: $('hub-pool'), slot: $('hub-slot'), cancel: $('hub-cancel'),
    criteria: $('hub-criteria'), queue: $('hub-queue'), next: $('hub-next'), close: $('hub-close'),
  };
  let mySlot = null;
  let criteria = 'money';

  function open({ mySlot: slot, entries = [], criteria: crit = 'money', speakerPool = 0 } = {}) {
    mySlot = slot;
    criteria = crit;
    // Speaker pass status + the pool (all speakers). SEAM: at go-real the pool is split among
    // booked slot-holders by stage time and paid over Lightning — per-speaker share NOT here.
    el.pool.innerHTML = `<span class="pass">🎙 Speaker pass · active</span>`
      + `⚡ Pool (all speakers): <b>${fmt(speakerPool)}</b> sats<span class="sub">split by stage time at payout</span>`;
    renderSlot();
    renderCancel(false);
    renderCriteria();
    renderQueue(entries);
    el.root.hidden = false;
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
