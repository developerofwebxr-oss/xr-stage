// ui/boardUI.js — the flat/mobile board surfaces: the COMPOSE form (post a comment,
// which costs a zap) and the ACTIVITY list (comments I've sent, from You → Activity).
// Container only: the wallet charge + board.post happen in main on confirmed; text
// entry is DOM for now (VR keyboard is a v2 slice).
//
//   createBoardUI({ toast, onPost })
//     openCompose({ cost }) · closeCompose()
//     openActivity(comments) · closeActivity()
//     closeAll() · isOpen()

import { MAX_LEN } from '../board/board.js';

const $ = (id) => document.getElementById(id);

export function createBoardUI({ toast, onPost } = {}) {
  const el = {
    compose: $('compose'),
    text: $('compose-text'),
    count: $('compose-count'),
    cost: $('compose-cost'),
    post: $('compose-post'),
    cancel: $('compose-cancel'),
    close: $('compose-close'),
    activity: $('activity'),
    activityList: $('activity-list'),
    activityClose: $('activity-close'),
  };

  // ── Compose ─────────────────────────────────────────────────────────────────────
  el.text.maxLength = MAX_LEN;
  const updateCount = () => { el.count.textContent = `${el.text.value.length}/${MAX_LEN}`; };
  el.text.addEventListener('input', updateCount);

  function openCompose({ cost = 21 } = {}) {
    el.text.value = '';
    el.cost.value = String(cost);
    updateCount();
    el.compose.hidden = false;
    el.text.focus();
  }
  function closeCompose() { el.compose.hidden = true; }

  el.post.addEventListener('click', () => {
    const text = el.text.value.trim();
    const amount = Math.floor(Number(el.cost.value));
    if (!text) return toast && toast('Write something first');
    if (!(amount > 0)) return toast && toast('Set a zap amount');
    onPost && onPost(text, amount); // main charges the zap, posts on confirmed, then closes
  });
  el.cancel.addEventListener('click', closeCompose);
  el.close.addEventListener('click', closeCompose);
  el.compose.addEventListener('click', (e) => { if (e.target === el.compose) closeCompose(); });

  // ── Activity (my comments) ──────────────────────────────────────────────────────
  function openActivity(comments = []) {
    el.activityList.innerHTML = '';
    if (!comments.length) {
      const empty = document.createElement('div');
      empty.className = 'act-empty';
      empty.textContent = 'No comments yet — post one from the Zap menu.';
      el.activityList.appendChild(empty);
    } else {
      for (const c of comments) {
        const row = document.createElement('div');
        row.className = 'act-row';
        row.innerHTML = `<span class="act-text"></span><span class="act-zaps">⚡ ${c.sats.toLocaleString('en-US')}</span>`;
        row.querySelector('.act-text').textContent = c.text; // textContent = no HTML injection
        el.activityList.appendChild(row);
      }
    }
    el.activity.hidden = false;
  }
  function closeActivity() { el.activity.hidden = true; }
  el.activityClose.addEventListener('click', closeActivity);
  el.activity.addEventListener('click', (e) => { if (e.target === el.activity) closeActivity(); });

  return {
    openCompose, closeCompose, openActivity, closeActivity,
    closeAll() { closeCompose(); closeActivity(); },
    isOpen: () => !el.compose.hidden || !el.activity.hidden,
  };
}
