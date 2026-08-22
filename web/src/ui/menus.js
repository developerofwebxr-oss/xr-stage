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
  function renderYou({ signedIn, name, faceUrl, balance, tier = 'ghost', tierLabel, visible = false, badge, speaker = false, lastSplit, held = null } = {}) {
    const paid = signedIn && tier !== 'ghost';
    const member = signedIn && (paid || speaker); // embodied participant: paid tier OR speaker pass
    el.youIdentity.innerHTML = signedIn
      ? `<img class="you-face" src="${faceUrl}" alt=""><div class="you-name"></div>`
      : `<div class="you-name muted">Not signed in</div>`;
    if (signedIn) el.youIdentity.querySelector('.you-name').textContent = name;

    // Ticket — the embodiment/tier home (signed in only). True ghost: "listening only" +
    // Get-a-ticket primary. Member (paid and/or speaker): status (+ badge + 🎙) + visibility toggle.
    const showTicket = signedIn;
    el.youTicketSec.hidden = !showTicket;
    el.youTicket.hidden = !showTicket;
    el.youTicket.innerHTML = '';
    if (showTicket) {
      const status = document.createElement('div');
      status.className = 'you-tier';
      if (member) {
        const marks = [];
        if (paid) marks.push(`<b>${esc(tierLabel || tier)}</b>`);
        if (badge) marks.push(`${badge === 'patron' ? '◆ Patron' : '◇ Supporter'} badge`);
        if (speaker) marks.push('🎙 Speaker');
        status.innerHTML = `${marks.join(' · ')} — ${visible ? 'embodied' : 'invisible'}`;
      } else {
        status.innerHTML = `<span class="muted">👻 Ghost — listening only. Get a ticket to be seen, zap, post &amp; enter zones. Or book a slot to speak.</span>`;
      }
      el.youTicket.appendChild(status);
      // Which EVENT this ticket/pass is for, and until when (event end + grace).
      if (member && held) {
        const w = document.createElement('div');
        w.className = 'you-split';
        w.innerHTML = `Ticket: <b>${esc(held.title)}</b> · until ${esc(held.until)}`;
        el.youTicket.appendChild(w);
      }
      // "Where your sats went" — the split of your last ATTENDEE purchase (null → not drawn;
      // a speaker who never bought a tier has none). Migration-safe.
      if (lastSplit) {
        const w = document.createElement('div');
        w.className = 'you-split';
        w.innerHTML = `venue <b>${fmtN(lastSplit.venue)}</b> · speakers <b>${fmtN(lastSplit.speakers)}</b> · credits <b>${fmtN(lastSplit.credits)}</b>`;
        el.youTicket.appendChild(w);
      }
      if (member) {
        el.youTicket.appendChild(btn(visible ? '👻 Go invisible' : '👁 Go visible', 'ctl', () => onToggleVisible && onToggleVisible()));
        el.youTicket.appendChild(btn(paid ? '🎟 Change tier' : '🎟 Get a ticket', 'ctl', () => onGetTicket && onGetTicket()));
      } else {
        el.youTicket.appendChild(btn('🎟 Get a ticket', 'ctl primary', () => onGetTicket && onGetTicket()));
      }
    }

    // Wallet — a LOCAL venue credit balance. Shown for MEMBERS (paid or speaker) so a speaker with
    // 0 credits can top up to zap. Signed out / true ghost: hidden.
    el.youWalletSec.hidden = !member;
    el.youWallet.hidden = !member;
    el.youWallet.innerHTML = '';
    if (member) {
      const b = document.createElement('div');
      b.className = 'you-balance';
      b.innerHTML = `⚡ Balance: <b>${fmt(balance)}</b> credits`;
      el.youWallet.appendChild(b);
      el.youWallet.appendChild(btn('⚡ Top up wallet', 'ctl primary', () => onTopUp && onTopUp()));
    }

    // Account. Signed out: Sign in primary + Enter code. Signed in: Activity (members) +
    // headset login + Switch / Log out.
    el.youAccount.innerHTML = '';
    if (signedIn) {
      if (member) el.youAccount.appendChild(btn('Activity', 'ctl', () => onActivity && onActivity()));
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

  // ── Stage menu (event schedule + Book / Speaker-hub) ────────────────────────────
  function renderStage({ events = [], currentId = null, hasBooking: booked = false, pot = 0, potTitle = '' } = {}) {
    hasBooking = booked;
    renderSchedule(events, currentId);
    setSpeakerPot(pot, potTitle);
    el.stageHub.classList.toggle('soon', !booked);
    el.stageHub.setAttribute('aria-disabled', String(!booked));
  }
  function openStage(data = {}) { renderStage(data); el.stage.hidden = false; }
  // The public per-event speaker pot — the growing pot that recruits speakers.
  function setSpeakerPot(sats, title) {
    el.stagePool.innerHTML = `⚡ This event's speaker pot: <b>${fmtN(sats)}</b> sats`
      + `<span class="sub">${title ? esc(title) + ' — ' : ''}10–30% of every ticket goes to its speakers</span>`;
    el.stagePool.hidden = false;
  }
  function closeStage() { el.stage.hidden = true; }
  // Schedule = the event line-up (title · organizer · time), the running one marked.
  function renderSchedule(events, currentId) {
    if (!events.length) { el.stageSched.innerHTML = '<div class="muted">No events booked yet.</div>'; return; }
    el.stageSched.innerHTML = events.map((e) => {
      const live = e.id === currentId;
      const desc = e.description ? String(e.description).slice(0, 90) + (e.description.length > 90 ? '…' : '') : '';
      return `<div class="sched-row${live ? ' live' : ''}">`
        + `<b>${esc(e.time)}</b>${live ? ' <span class="live-tag">● live</span>' : ''} · `
        + `${esc(e.title)} <span class="muted">— ${esc(e.organizer)}</span>`
        + (desc ? `<div class="sched-desc muted" style="font-size:11px;margin-top:2px">${esc(desc)}</div>` : '')
        + `</div>`;
    }).join('');
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
    openYou, closeYou, renderYou, openStage, closeStage, renderStage, setSpeakerPot, openInstructions, closeInstructions,
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
