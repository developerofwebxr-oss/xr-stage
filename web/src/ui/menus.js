// ui/menus.js — the "home" surfaces: the YOU menu (identity + wallet), the STAGE menu
// (live schedule + Book / Speaker-hub buttons), and the shared INSTRUCTIONS panel.
// Containers only — data + live actions are passed in; a not-yet-live button is DIMMED
// and toasts on tap (no "coming soon" copy). The Booking surface and Speaker hub are
// their own modules (bookingUI / speakerHub); the Stage menu just opens them.
//
//   createMenus({ toast, onSignIn, onSwitch, onLogout, onTopUp, onActivity,
//                 onBookOpen, onSpeakerHubOpen })
//     openYou({ signedIn, name, faceUrl, balance }) · closeYou()  (balance shown only signed-in)
//     openStage({ nowNext, hasBooking }) · closeStage()
//     openInstructions() · closeInstructions()
//     closeAll() · isOpen()

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const NOT_YET = 'Not available yet';

export function createMenus({
  toast, onSignIn, onSwitch, onLogout, onTopUp, onActivity, onBookOpen, onSpeakerHubOpen,
  onLoginHeadset, onEnterCode, onGetTicket, onToggleVisible,
} = {}) {
  const el = {
    you: $('you-menu'), youIdentity: $('you-identity'), youWallet: $('you-wallet'), youAccount: $('you-account'),
    youTicket: $('you-ticket'), youTicketSec: $('you-ticket-sec'), youWalletSec: $('you-wallet-sec'),
    stage: $('stage-menu'), stageSched: $('stage-sched'), stageHub: $('stage-speaker-hub'), stagePool: $('stage-pool'),
    instructions: $('instructions'),
  };
  const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
  const dim = (msg = NOT_YET) => toast && toast(msg);
  let hasBooking = false; // gates the Speaker-hub button

  // ── You menu (identity + wallet home) ───────────────────────────────────────────
  function openYou(info = {}) { renderYou(info); el.you.hidden = false; }
  function closeYou() { el.you.hidden = true; }
  function renderYou({ signedIn, name, faceUrl, balance, tier = 'ghost', tierLabel, visible = false, badge, lastSplit } = {}) {
    const paid = signedIn && tier !== 'ghost';
    el.youIdentity.innerHTML = signedIn
      ? `<img class="you-face" src="${faceUrl}" alt=""><div class="you-name"></div>`
      : `<div class="you-name muted">Not signed in</div>`;
    if (signedIn) el.youIdentity.querySelector('.you-name').textContent = name;

    // Ticket — the embodiment/tier home. Shown only when signed in. Ghost: "listening only" +
    // Get-a-ticket primary. Paid: tier (+ badge) + a Go-invisible / Go-visible toggle.
    const showTicket = signedIn;
    el.youTicketSec.hidden = !showTicket;
    el.youTicket.hidden = !showTicket;
    el.youTicket.innerHTML = '';
    if (showTicket) {
      const status = document.createElement('div');
      status.className = 'you-tier';
      if (paid) {
        const b = badge ? ` · ${badge === 'patron' ? '◆ Patron' : '◇ Supporter'} badge` : '';
        status.innerHTML = `<b>${esc(tierLabel || tier)}</b>${b} — ${visible ? 'embodied' : 'invisible (ghost)'}`;
      } else {
        status.innerHTML = `<span class="muted">👻 Ghost — listening only. Get a ticket to be seen, zap, post &amp; enter zones.</span>`;
      }
      el.youTicket.appendChild(status);
      // "Where your sats went" — the transparent split of your last purchase (migration-safe:
      // old records have no split → default the fields to 0).
      if (paid && lastSplit) {
        const w = document.createElement('div');
        w.className = 'you-split';
        w.innerHTML = `venue <b>${fmtN(lastSplit.venue)}</b> · speakers <b>${fmtN(lastSplit.speakers)}</b> · credits <b>${fmtN(lastSplit.credits)}</b>`;
        el.youTicket.appendChild(w);
      }
      if (paid) {
        el.youTicket.appendChild(btn(visible ? '👻 Go invisible' : '👁 Go visible', 'ctl', () => onToggleVisible && onToggleVisible()));
        el.youTicket.appendChild(btn('🎟 Change tier', 'ctl', () => onGetTicket && onGetTicket()));
      } else {
        el.youTicket.appendChild(btn('🎟 Get a ticket', 'ctl primary', () => onGetTicket && onGetTicket()));
      }
    }

    // Wallet — a LOCAL venue credit balance. Meaningful once you hold a ticket, so it's shown
    // for paid tiers only (ghosts have nothing to spend). Signed out / ghost: hidden.
    el.youWalletSec.hidden = !paid;
    el.youWallet.hidden = !paid;
    el.youWallet.innerHTML = '';
    if (paid) {
      const b = document.createElement('div');
      b.className = 'you-balance';
      b.innerHTML = `⚡ Balance: <b>${fmt(balance)}</b> credits`;
      el.youWallet.appendChild(b);
      el.youWallet.appendChild(btn('⚡ Top up wallet', 'ctl primary', () => onTopUp && onTopUp()));
    }

    // Account. Signed out: Sign in primary + Enter code. Signed in: Activity (ticketed only) +
    // headset login + Switch / Log out.
    el.youAccount.innerHTML = '';
    if (signedIn) {
      if (paid) el.youAccount.appendChild(btn('Activity', 'ctl', () => onActivity && onActivity()));
      else el.youAccount.appendChild(btn('Activity', 'ctl soon', () => toast && toast('Get a ticket first')));
      el.youAccount.appendChild(btn('📟 Log in on headset', 'ctl', () => onLoginHeadset && onLoginHeadset()));
      el.youAccount.appendChild(btn('Switch account', 'ctl', () => onSwitch && onSwitch()));
      el.youAccount.appendChild(btn('Log out', 'ctl', () => onLogout && onLogout()));
    } else {
      el.youAccount.appendChild(btn('Sign in', 'ctl primary', () => onSignIn && onSignIn()));
      el.youAccount.appendChild(btn('📟 Enter code', 'ctl', () => onEnterCode && onEnterCode()));
      el.youAccount.appendChild(btn('Activity', 'ctl soon', () => toast && toast('Sign in first')));
    }
  }

  // ── Stage menu (live schedule + Book / Speaker-hub) ─────────────────────────────
  function openStage({ nowNext = { now: null, next: null }, hasBooking: booked = false, speakerPool = 0 } = {}) {
    hasBooking = booked;
    renderSchedule(nowNext);
    setSpeakerPool(speakerPool);
    el.stageHub.classList.toggle('soon', !booked);
    el.stageHub.setAttribute('aria-disabled', String(!booked));
    el.stage.hidden = false;
  }
  // The public speaker-pool number — the growing pot that recruits speakers. Updates live
  // (main calls this on pool growth) whether or not the Stage menu is open.
  function setSpeakerPool(sats) {
    el.stagePool.innerHTML = `⚡ Speaker pool: <b>${fmtN(sats)}</b> sats<span class="sub">10–30% of every ticket goes to the speakers</span>`;
    el.stagePool.hidden = false;
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
    openYou, closeYou, openStage, closeStage, setSpeakerPool, openInstructions, closeInstructions,
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
