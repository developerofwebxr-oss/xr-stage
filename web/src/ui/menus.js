// ui/menus.js — the "home" surfaces: the YOU menu (identity + wallet), the STAGE menu
// (live schedule + Book / Speaker-hub buttons), and the shared INSTRUCTIONS panel.
// Containers only — data + live actions are passed in; a not-yet-live button is DIMMED
// and toasts on tap (no "coming soon" copy). The Booking surface and Speaker hub are
// their own modules (bookingUI / speakerHub); the Stage menu just opens them.
//
//   createMenus({ toast, onSignIn, onSwitch, onLogout, onConnectWallet, onActivity,
//                 onBookOpen, onSpeakerHubOpen })
//     openYou({ signedIn, name, faceUrl, walletConnected, balance }) · closeYou()
//     openStage({ nowNext, hasBooking }) · closeStage()
//     openInstructions() · closeInstructions()
//     closeAll() · isOpen()

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const NOT_YET = 'Not available yet';

export function createMenus({
  toast, onSignIn, onSwitch, onLogout, onConnectWallet, onActivity, onBookOpen, onSpeakerHubOpen,
} = {}) {
  const el = {
    you: $('you-menu'), youIdentity: $('you-identity'), youWallet: $('you-wallet'), youAccount: $('you-account'),
    stage: $('stage-menu'), stageSched: $('stage-sched'), stageHub: $('stage-speaker-hub'),
    instructions: $('instructions'),
  };
  const dim = (msg = NOT_YET) => toast && toast(msg);
  let hasBooking = false; // gates the Speaker-hub button

  // ── You menu (identity + wallet home) ───────────────────────────────────────────
  function openYou(info = {}) { renderYou(info); el.you.hidden = false; }
  function closeYou() { el.you.hidden = true; }
  function renderYou({ signedIn, name, faceUrl, walletConnected, balance } = {}) {
    el.youIdentity.innerHTML = signedIn
      ? `<img class="you-face" src="${faceUrl}" alt=""><div class="you-name"></div>`
      : `<div class="you-name muted">Not signed in</div>`;
    if (signedIn) el.youIdentity.querySelector('.you-name').textContent = name;

    el.youWallet.innerHTML = '';
    if (walletConnected) {
      const b = document.createElement('div');
      b.className = 'you-balance';
      b.innerHTML = `⚡ Balance: <b>${fmt(balance)}</b> sats`;
      el.youWallet.appendChild(b);
    } else {
      el.youWallet.appendChild(btn('Connect wallet', 'ctl primary', () => onConnectWallet && onConnectWallet()));
    }

    el.youAccount.innerHTML = '';
    el.youAccount.appendChild(btn('Activity', 'ctl', () => onActivity && onActivity()));
    if (signedIn) {
      el.youAccount.appendChild(btn('Switch account', 'ctl', () => onSwitch && onSwitch()));
      el.youAccount.appendChild(btn('Log out', 'ctl', () => onLogout && onLogout()));
    } else {
      el.youAccount.appendChild(btn('Sign in', 'ctl', () => onSignIn && onSignIn()));
    }
  }

  // ── Stage menu (live schedule + Book / Speaker-hub) ─────────────────────────────
  function openStage({ nowNext = { now: null, next: null }, hasBooking: booked = false } = {}) {
    hasBooking = booked;
    renderSchedule(nowNext);
    el.stageHub.classList.toggle('soon', !booked);
    el.stageHub.setAttribute('aria-disabled', String(!booked));
    el.stage.hidden = false;
  }
  function closeStage() { el.stage.hidden = true; }
  function renderSchedule(nowNext) {
    if (!nowNext.now && !nowNext.next) {
      el.stageSched.innerHTML = '<div class="muted">No one booked yet.</div>';
      return;
    }
    el.stageSched.innerHTML = schedLine('Now', nowNext.now) + schedLine('Up next', nowNext.next);
  }
  function schedLine(label, s) {
    if (!s) return `<div>${label}: <b>—</b></div>`;
    return `<div>${label}: <b>${esc(s.time)}</b> · ${esc(s.name)} — ${esc(s.title)}</div>`;
  }

  // ── Instructions ────────────────────────────────────────────────────────────────
  function openInstructions() { el.instructions.hidden = false; }
  function closeInstructions() { el.instructions.hidden = true; }

  // Static buttons declared in index.html.
  wireClose(el.you, 'you-close', closeYou);
  wireClose(el.stage, 'stage-close', closeStage);
  wireClose(el.instructions, 'instructions-close', closeInstructions);
  $('stage-book')?.addEventListener('click', () => onBookOpen && onBookOpen());          // → booking surface
  el.stageHub.addEventListener('click', () => {
    if (hasBooking) onSpeakerHubOpen && onSpeakerHubOpen();
    else dim('Book a slot to unlock the Speaker hub');
  });

  function wireClose(overlay, closeId, fn) {
    document.getElementById(closeId)?.addEventListener('click', fn);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) fn(); }); // backdrop click closes
  }

  return {
    openYou, closeYou, openStage, closeStage, openInstructions, closeInstructions,
    closeAll() { closeYou(); closeStage(); closeInstructions(); },
    isOpen: () => [el.you, el.stage, el.instructions].some((n) => !n.hidden),
  };
}

function btn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = label;
  if (cls.includes('soon')) b.setAttribute('aria-disabled', 'true');
  b.addEventListener('click', onClick);
  return b;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
