// ui/menus.js — the "home" surfaces added by the menu-shell slice: the YOU menu
// (identity + wallet), the STAGE menu (schedule + booking seam), plus the shared
// INSTRUCTIONS and BOOKING panels. Containers only — identity/wallet DATA and the live
// actions are passed in; a not-yet-live button is simply DIMMED and toasts on tap (no
// "coming soon" copy, no fake behaviour).
//
// Each surface is a full-screen modal (invisible in immersive VR — the in-world VR
// versions are the deferred VR-UI slice). main.js coordinates one-at-a-time behaviour.
//
//   createMenus({ toast, onSignIn, onSwitch, onLogout, onConnectWallet, onBookOpen })
//     openYou({ signedIn, name, faceUrl, walletConnected, balance }) · closeYou()
//     openStage() · closeStage()
//     openInstructions() · closeInstructions()
//     openBooking() · closeBooking()
//     closeAll() · isOpen()

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const NOT_YET = 'Not available yet';

export function createMenus({ toast, onSignIn, onSwitch, onLogout, onConnectWallet, onBookOpen } = {}) {
  const el = {
    you: $('you-menu'), youIdentity: $('you-identity'), youWallet: $('you-wallet'), youAccount: $('you-account'),
    stage: $('stage-menu'),
    instructions: $('instructions'),
    booking: $('booking'),
  };
  const dim = (msg = NOT_YET) => toast && toast(msg);

  // ── You menu (identity + wallet home) ───────────────────────────────────────────
  function openYou(info = {}) { renderYou(info); el.you.hidden = false; }
  function closeYou() { el.you.hidden = true; }
  function renderYou({ signedIn, name, faceUrl, walletConnected, balance } = {}) {
    el.youIdentity.innerHTML = signedIn
      ? `<img class="you-face" src="${faceUrl}" alt=""><div class="you-name">${name}</div>`
      : `<div class="you-name muted">Not signed in</div>`;

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
    el.youAccount.appendChild(btn('Activity', 'ctl soon', () => dim(), true)); // → future zap-comment history
    if (signedIn) {
      el.youAccount.appendChild(btn('Switch account', 'ctl', () => onSwitch && onSwitch()));
      el.youAccount.appendChild(btn('Log out', 'ctl', () => onLogout && onLogout()));
    } else {
      el.youAccount.appendChild(btn('Sign in', 'ctl', () => onSignIn && onSignIn()));
    }
  }

  // ── Stage menu (schedule + booking seam) ────────────────────────────────────────
  function openStage() { el.stage.hidden = false; }
  function closeStage() { el.stage.hidden = true; }

  // ── Instructions / Booking panels ───────────────────────────────────────────────
  function openInstructions() { el.instructions.hidden = false; }
  function closeInstructions() { el.instructions.hidden = true; }
  function openBooking() { el.booking.hidden = false; }
  function closeBooking() { el.booking.hidden = true; }

  // Static buttons declared in index.html.
  wireClose(el.you, 'you-close', closeYou);
  wireClose(el.stage, 'stage-close', closeStage);
  wireClose(el.instructions, 'instructions-close', closeInstructions);
  wireClose(el.booking, 'booking-close', closeBooking);
  $('stage-book')?.addEventListener('click', () => onBookOpen && onBookOpen());        // live → booking surface
  $('stage-speaker-hub')?.addEventListener('click', () => dim());                       // dim → toast (needs a booked slot)
  $('booking-request')?.addEventListener('click', () => dim());                         // dim → toast (booking not live)

  function wireClose(overlay, closeId, fn) {
    document.getElementById(closeId)?.addEventListener('click', fn);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) fn(); }); // backdrop click closes
  }

  return {
    openYou, closeYou, openStage, closeStage,
    openInstructions, closeInstructions, openBooking, closeBooking,
    closeAll() { closeYou(); closeStage(); closeInstructions(); closeBooking(); },
    isOpen: () => [el.you, el.stage, el.instructions, el.booking].some((n) => !n.hidden),
  };
}

function btn(label, cls, onClick, dimmed = false) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = label;
  if (dimmed) b.setAttribute('aria-disabled', 'true');
  b.addEventListener('click', onClick);
  return b;
}
