// ui/sessionUI.js — the two DOM surfaces for cross-device headset login.
//
//   MINT  (#session-code):   a signed-in phone/desktop shows a one-time code + live
//                            countdown; Regenerate mints a fresh one.
//   REDEEM (#session-redeem): any device types a 6-digit code to adopt that identity.
//
// Container only: the network + identity work is injected.
//   createSessionUI({ toast, onMint, onRedeem, onAdopted })
//     onMint()          async () → { code, expiresAt }
//     onRedeem(code)    async (code) → PUBLIC profile   (throws Error(msg) on failure)
//     onAdopted(profile) → the caller becomes that identity (updates HUD/wallet)
//     openMint() · closeMint() · openRedeem() · closeRedeem() · closeAll() · isOpen()

const $ = (id) => document.getElementById(id);

export function createSessionUI({ toast, onMint, onRedeem, onAdopted } = {}) {
  const el = {
    mint: $('session-code'), code: $('sc-code'), count: $('sc-count'),
    regen: $('sc-regen'), scClose: $('sc-close'),
    redeem: $('session-redeem'), input: $('sr-input'), error: $('sr-error'),
    submit: $('sr-submit'), srCancel: $('sr-cancel'), srClose: $('sr-close'),
  };
  let expiresAt = 0, ticker = null, minting = false, redeeming = false;

  // ── Mint side ─────────────────────────────────────────────────────────────────
  async function openMint() {
    el.mint.hidden = false;
    await refreshCode();
  }
  function closeMint() { stopTicker(); el.mint.hidden = true; }

  async function refreshCode() {
    if (minting) return;
    minting = true;
    stopTicker();
    el.code.textContent = '••••••';
    el.count.textContent = 'getting a code…';
    el.count.classList.remove('expired');
    try {
      const { code, expiresAt: exp } = await onMint();
      el.code.textContent = code;
      expiresAt = exp || (Date.now() + 5 * 60 * 1000);
      startTicker();
    } catch (err) {
      el.code.textContent = '——';
      el.count.textContent = err?.message || 'Could not create a code';
      el.count.classList.add('expired');
    } finally {
      minting = false;
    }
  }

  function startTicker() { stopTicker(); tick(); ticker = setInterval(tick, 500); }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }
  function tick() {
    const ms = expiresAt - Date.now();
    if (ms <= 0) {
      stopTicker();
      el.count.textContent = 'code expired — regenerate';
      el.count.classList.add('expired');
      return;
    }
    const s = Math.floor(ms / 1000);
    el.count.textContent = `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.count.classList.remove('expired');
  }

  // ── Redeem side ───────────────────────────────────────────────────────────────
  function openRedeem() {
    el.redeem.hidden = false;
    el.input.value = '';
    showError('');
    setTimeout(() => el.input.focus(), 0);
  }
  function closeRedeem() { el.redeem.hidden = true; }
  function showError(msg) { el.error.textContent = msg || ''; el.error.hidden = !msg; }

  async function submitCode() {
    if (redeeming) return;
    const code = (el.input.value || '').replace(/\D/g, '');
    if (code.length !== 6) return showError('Enter the 6-digit code');
    redeeming = true;
    showError('');
    el.submit.disabled = true;
    try {
      const profile = await onRedeem(code);
      closeRedeem();
      onAdopted && onAdopted(profile);
      toast && toast(`Logged in as ${profile.name}`);
    } catch (err) {
      showError(err?.message || 'Code invalid or expired');
    } finally {
      redeeming = false;
      el.submit.disabled = false;
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────────
  el.regen.addEventListener('click', refreshCode);
  el.scClose.addEventListener('click', closeMint);
  el.mint.addEventListener('click', (e) => { if (e.target === el.mint) closeMint(); }); // backdrop

  el.submit.addEventListener('click', submitCode);
  el.srCancel.addEventListener('click', closeRedeem);
  el.srClose.addEventListener('click', closeRedeem);
  el.redeem.addEventListener('click', (e) => { if (e.target === el.redeem) closeRedeem(); }); // backdrop
  // Digits only; Enter submits.
  el.input.addEventListener('input', () => { el.input.value = el.input.value.replace(/\D/g, '').slice(0, 6); if (el.error && !el.error.hidden) showError(''); });
  el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCode(); } });

  return {
    openMint, closeMint, openRedeem, closeRedeem,
    closeAll() { closeMint(); closeRedeem(); },
    isOpen: () => !el.mint.hidden || !el.redeem.hidden,
  };
}
