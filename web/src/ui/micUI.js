// ui/micUI.js — the flat/mobile form for the paid mic queue (⚡ Take the mic). Collects
// an amount (presets + custom, like the zap picker) and an optional one-line pitch, then
// hands off to main which charges through the wallet and joins/tops-up via the queue
// service. Shows your live position when you're already in the queue.
//
//   createMicUI({ toast, onJoin, onTopUp })
//     open({ inQueue, position, count, total, pitch })
//     close()
//     setState({ inQueue, position, count })   // live-update while open
//     isOpen()

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');

export function createMicUI({ toast, onJoin, onTopUp } = {}) {
  const el = {
    form: $('micform'),
    close: $('mic-close'),
    position: $('mic-position'),
    presets: $('mic-presets'),
    amount: $('mic-amount'),
    pitch: $('mic-pitch'),
    cancel: $('mic-cancel'),
    confirm: $('mic-confirm'),
  };
  let inQueue = false;

  function setAmount(v) {
    el.amount.value = String(v);
    for (const b of el.presets.querySelectorAll('.zp-preset')) {
      b.classList.toggle('sel', Number(b.dataset.amt) === Number(v));
    }
  }
  function renderPosition({ inQueue: q, position, count, total }) {
    if (q) {
      el.position.hidden = false;
      el.position.innerHTML = `You're <b>#${position}</b> of ${count} · ⚡ <b>${fmt(total || 0)}</b>`;
    } else {
      el.position.hidden = true;
    }
    el.confirm.textContent = q ? 'Top up ⚡' : 'Join queue ⚡';
  }

  function open({ inQueue: q = false, position = null, count = 0, total = 0, pitch = '' } = {}) {
    inQueue = q;
    setAmount(21);
    el.pitch.value = pitch || '';
    renderPosition({ inQueue: q, position, count, total });
    el.form.hidden = false;
    (q ? el.amount : el.pitch).focus?.();
  }
  function close() { el.form.hidden = true; }
  // Live-update the position line + button while the form is open (queue.onChange).
  function setState(s) { if (!el.form.hidden) { inQueue = s.inQueue; renderPosition(s); } }

  el.presets.addEventListener('click', (e) => {
    const b = e.target.closest('.zp-preset');
    if (b) setAmount(Number(b.dataset.amt));
  });
  el.amount.addEventListener('input', () => setAmount(el.amount.value));
  el.close.addEventListener('click', close);
  el.cancel.addEventListener('click', close);
  el.form.addEventListener('click', (e) => { if (e.target === el.form) close(); });
  el.confirm.addEventListener('click', () => {
    const amount = Math.floor(Number(el.amount.value));
    const pitch = el.pitch.value.trim();
    if (!(amount > 0)) return toast && toast('Set a zap amount');
    if (inQueue) onTopUp && onTopUp(amount);
    else onJoin && onJoin(amount, pitch);
  });

  return { open, close, setState, isOpen: () => !el.form.hidden };
}
