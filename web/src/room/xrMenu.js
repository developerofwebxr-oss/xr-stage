import * as THREE from 'three';

// room/xrMenu.js — the IN-WORLD VR/AR menu (Prompt 4.2). The headset's first real UI:
// a 3D, laser-clickable panel opened by the X button (the standard Pause/Menu binding),
// carrying the essentials so a headset user can sign in, buy a ticket, top up, toggle
// voice/comfort and zap — all without removing the headset. The DOM stays the flat-mode
// UI; this is its immersive sibling (shared SERVICE state, different renderer).
//
// Architecture (matches queuePanel.js): ONE opaque canvas-textured mesh (3.11 solid-panel
// rule — writes depth, occludes correctly), re-textured ONLY on state change (page switch,
// value change, or hover change) — never per frame. Buttons are rectangles in canvas space;
// a laser hit on the plane maps its local point → canvas coords → the button under it, so a
// single mesh is the raycast target (no dozens of sub-meshes). Pages: main · tickets · keypad.
//
//   createXrMenu(scene, { camera, renderer, actions, state })
//     → { open, close, toggle, isOpen, targets, pressWorld, hoverAt, update, dispose }
//
// The panel anchors ~1.2 m in front of the camera AT OPEN, then is world-LOCKED in position
// (not head-glued) and only billboards (yaw) to keep facing you. Disposed of on close.

const BITCOIN = '#f7931a';
const BG = '#0b0d13';
const INK = '#eceef5';
const INK_DIM = 'rgba(236,238,245,0.62)';
const BTN_BG = 'rgba(22,26,36,0.96)';
const BTN_LINE = 'rgba(247,147,26,0.42)';
const HOVER_BG = 'rgba(247,147,26,0.24)';
const ON_BG = 'rgba(247,147,26,0.9)';
const VIOLET = '#9b6cff';

const CW = 700, CH = 900;                 // panel canvas px
const PANEL_H = 1.5;                      // world metres (portrait)
const PANEL_W = PANEL_H * (CW / CH);      // keep aspect → no text distortion
const PAD = 34;
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
const SANS = 'system-ui, -apple-system, sans-serif';

export function createXrMenu(scene, { camera, renderer, actions, state }) {
  const group = new THREE.Group();
  group.visible = false;

  const canvas = document.createElement('canvas');
  canvas.width = CW; canvas.height = CH;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture }); // OPAQUE (depth-correct)
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), material);
  panel.userData.xrMenu = true;            // raycast dispatch key (see main pickFromRaycaster)
  group.add(panel);
  scene.add(group);

  let open = false;
  let page = 'main';
  let hovered = null;      // id of the button under the laser (drives the highlight)
  let notice = '';         // transient status line (result of an action)
  let codeBuf = '';        // keypad entry buffer (6 digits)
  let eventInfo = null;    // { title, speaker } for the transition Event page (4.11 #2)
  let busy = false;        // an async action (buy / redeem) is in flight
  let buttons = [];        // current page hit-rects: [{ id, x, y, w, h }]

  const _camPos = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _local = new THREE.Vector3();

  // The immersive HEAD pose. In XR the mono `camera`'s LOCAL transform is NOT the head at
  // input time — Three writes the head pose into it during render(), AFTER the X-button
  // handler that opens this menu runs — so anchoring off `camera.getWorldPosition()` here
  // spawns the panel off your gaze (it reads the stale rig-relative transform). The live
  // head world matrix lives on `renderer.xr.getCamera()`; read position + forward from it.
  function headPose(outPos, outDir) {
    const cam = renderer && renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    outPos.setFromMatrixPosition(cam.matrixWorld);
    if (outDir) outDir.set(0, 0, -1).transformDirection(cam.matrixWorld); // normalized forward
  }

  // ── Open / close ────────────────────────────────────────────────────────────────
  function openMenu() {
    headPose(_camPos, _dir);
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-4) _dir.set(0, 0, -1);
    _dir.normalize();
    group.position.copy(_camPos).addScaledVector(_dir, 1.2); // 1.2 m ahead of gaze, then world-locked
    group.position.y = _camPos.y - 0.12;                     // just below eye line
    open = true; group.visible = true;
    page = 'main'; hovered = null; notice = ''; codeBuf = ''; busy = false;
    faceCamera();
    render();
  }
  function closeMenu() { open = false; group.visible = false; hovered = null; }
  function toggle() { open ? closeMenu() : openMenu(); }

  // Yaw-only billboard: face the head, stay upright (readable). Position never moves.
  function faceCamera() {
    headPose(_camPos, null);
    group.rotation.set(0, Math.atan2(_camPos.x - group.position.x, _camPos.z - group.position.z), 0);
  }

  function update() {                        // per frame while open: cheap rotation only
    if (open) faceCamera();
  }

  // ── Raycast bridge ──────────────────────────────────────────────────────────────
  function targets() { return open ? [panel] : []; }

  // Map a world-space hit on the plane → the button under it (or null).
  function buttonAt(worldPoint) {
    panel.worldToLocal(_local.copy(worldPoint));
    const cx = (_local.x / PANEL_W + 0.5) * CW;
    const cy = (0.5 - _local.y / PANEL_H) * CH;
    for (const b of buttons) {
      if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) return b;
    }
    return null;
  }

  // Hover: called each frame with the laser's world hit point (or null). Re-textures ONLY
  // when the hovered button actually changes — never per frame.
  function hoverAt(worldPoint) {
    if (!open) return;
    const id = worldPoint ? (buttonAt(worldPoint)?.id ?? null) : null;
    if (id !== hovered) { hovered = id; render(); }
  }

  // Press: the unified select path hands us the world hit point → dispatch the button.
  function pressWorld(worldPoint) {
    if (!open || busy) return;
    const b = buttonAt(worldPoint);
    if (b) doAction(b.id);
  }

  // ── Actions (renderers over existing service flows — no new service logic here) ────
  function needsSignIn() {
    if (state.signedIn()) return false;
    page = 'keypad'; codeBuf = ''; notice = 'Enter your 6-digit code to sign in'; render();
    return true;
  }

  async function doAction(id) {
    if (id === 'resume') return closeMenu();
    if (id === 'exit') { closeMenu(); return actions.exit(); }
    if (id === 'back') { page = 'main'; notice = ''; return render(); }

    if (id === 'ticket') { if (needsSignIn()) return; page = 'tickets'; notice = ''; return render(); }
    if (id === 'code') { page = 'keypad'; codeBuf = ''; notice = ''; return render(); }
    if (id === 'topup') {
      if (needsSignIn()) return;
      actions.topUp(); notice = `Topped up · balance ⚡ ${fmt(state.balance())}`; return render();
    }
    if (id === 'requests') { page = 'requests'; notice = ''; return render(); }
    if (id === 'emotes') { page = 'emotes'; notice = ''; return render(); }
    if (id === 'evt-ticket') { page = 'tickets'; notice = ''; return render(); }        // → in-world tiers (event-scoped)
    if (id === 'evt-zap') { actions.welcomeZap(); return closeMenu(); }                  // ⚡ welcome zap
    if (id === 'evt-ghost') { actions.continueGhost(); return closeMenu(); }             // dismiss + lapse
    if (id.startsWith('emote:')) { actions.emote(id.slice(6)); return closeMenu(); } // play + close so the burst shows
    if (id.startsWith('zap-spk:')) { actions.zapPickedSpeaker(id.slice(8)); notice = '⚡ Zapped'; page = 'main'; return render(); }
    if (id.startsWith('req-accept:')) { actions.acceptTalk(id.slice(11)); notice = 'Talk link opened'; page = 'main'; return render(); }
    if (id.startsWith('req-decline:')) { actions.declineTalk(id.slice(12)); return render(); }
    if (id === 'boost') { actions.toggleBoost(); return render(); }
    if (id === 'voice') { render(); await actions.toggleVoice(); return render(); }
    if (id === 'zap') {
      if (needsSignIn()) return;
      const spks = state.zapSpeakers ? state.zapSpeakers() : [];
      if (spks.length > 1) { page = 'speakers'; notice = ''; return render(); }  // panel → picker page
      actions.zapSpeaker();
      notice = state.speakerPresent() || spks.length ? '⚡ Zapped the speaker' : 'No one on stage to zap';
      return render();
    }
    if (id.startsWith('comfort:')) { const k = id.slice(8); actions.setComfort(k, !state.comfort()[k]); return render(); }

    if (id.startsWith('tier:')) {
      const tier = id.slice(5);
      busy = true; notice = 'Purchasing…'; render();
      const res = await actions.buyTicket(tier);
      busy = false;
      if (res && res.state === 'confirmed') { notice = `You're in — ${state.tierLabel()}`; page = 'main'; }
      else notice = res?.reason ? `Couldn't buy: ${res.reason}` : "Couldn't buy ticket";
      return render();
    }

    if (id.startsWith('key:')) {
      const k = id.slice(4);
      if (k === 'del') codeBuf = codeBuf.slice(0, -1);
      else if (k === 'submit') {
        if (codeBuf.length !== 6 || busy) { notice = 'Enter all 6 digits'; return render(); }
        busy = true; notice = 'Checking code…'; render();
        try {
          const profile = await actions.redeem(codeBuf);
          busy = false; codeBuf = '';
          notice = `Signed in as ${profile?.name || 'you'}`;
          page = 'main';
        } catch (err) {
          busy = false; codeBuf = '';
          notice = err?.message ? `Code failed: ${err.message}` : 'Invalid or expired code';
        }
        return render();
      } else if (codeBuf.length < 6) codeBuf += k;
      return render();
    }
  }

  // ── Rendering (one canvas, re-textured on change) ─────────────────────────────────
  function render() {
    buttons = [];
    g.fillStyle = BG; g.fillRect(0, 0, CW, CH);
    roundRect(g, 6, 6, CW - 12, CH - 12, 24); g.lineWidth = 3; g.strokeStyle = BITCOIN; g.stroke();

    if (page === 'main') renderMain();
    else if (page === 'tickets') renderTickets();
    else if (page === 'keypad') renderKeypad();
    else if (page === 'requests') renderRequests();
    else if (page === 'speakers') renderSpeakers();
    else if (page === 'emotes') renderEmotes();
    else if (page === 'event') renderEvent();

    if (notice) {
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = INK_DIM; g.font = `500 24px ${MONO}`;
      g.fillText(clip(g, notice, CW - 2 * PAD), CW / 2, CH - 30);
    }
    texture.needsUpdate = true;
  }

  function title(text, sub) {
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = BITCOIN; g.font = `700 46px ${MONO}`;
    g.fillText(text, CW / 2, 56);
    if (sub) { g.fillStyle = INK_DIM; g.font = `400 24px ${SANS}`; g.fillText(clip(g, sub, CW - 2 * PAD), CW / 2, 96); }
  }

  function renderMain() {
    title('MENU', state.eventTitle() ? `now: ${state.eventTitle()}` : null);
    let y = 132;
    const full = CW - 2 * PAD;
    const half = (full - 16) / 2;

    // Resume | Exit
    button('resume', PAD, y, half, 66, 'Resume');
    button('exit', PAD + half + 16, y, half, 66, 'Exit to Screen'); y += 82;

    // Ticket status + Get/Upgrade
    const tl = state.tierLabel() || 'Ghost';
    button('ticket', PAD, y, full, 66, `Ticket: ${tl}`, { right: state.tier() === 'patron' ? '—' : 'Get / Upgrade ›', accent: true }); y += 82;

    // Wallet balance + Top up
    button('topup', PAD, y, full, 66, `Wallet: ⚡ ${fmt(state.balance())}`, { right: `Top up +${fmt(21000)} ›` }); y += 82;

    // Sign-in / code
    if (state.signedIn()) button('code', PAD, y, full, 60, `Signed in as ${clip(g, state.name() || 'you', 260)}`, { right: 'Switch code ›', dim: true });
    else button('code', PAD, y, full, 66, 'Enter session code', { right: 'sign in ›', accent: true });
    y += 78;

    // Toggles: boost-by-tap, voice
    toggle('boost', PAD, y, full, 58, 'Boost by tap', state.boostOn()); y += 68;
    toggle('voice', PAD, y, full, 58, `${state.voiceVerb} (voice)`, state.voiceOn()); y += 68;

    // Comfort (three chips on one row)
    g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = INK_DIM; g.font = `500 22px ${SANS}`;
    g.fillText('Comfort', PAD, y + 8); y += 26;
    const keys = state.comfortKeys, cw = (full - 2 * 12) / keys.length, cm = state.comfort();
    keys.forEach((k, i) => toggle(`comfort:${k}`, PAD + i * (cw + 12), y, cw, 56, COMFORT_LABEL[k] || k, !!cm[k], true));
    y += 74;

    // Zap the speaker + Emotes (two half-width)
    const halfz = (full - 16) / 2;
    button('zap', PAD, y, halfz, 66, 'Zap speaker ⚡', { accent: true });
    button('emotes', PAD + halfz + 16, y, halfz, 66, '😀 Emotes'); y += 78;

    // Talk requests (Networking) — only when someone has asked to talk
    const reqs = state.talkRequests ? state.talkRequests() : [];
    if (reqs.length) button('requests', PAD, y, full, 58, '🤝 Talk requests', { right: `${reqs.length} ›`, accent: true });
  }

  // Transition prompt, in-world twin (4.11 #2): title + speaker(s), same three actions as the
  // DOM prompt (Get a ticket → the tiers page · ⚡ Welcome zap · Continue as ghost).
  function renderEvent() {
    title('NEW EVENT', 'now on stage');
    const full = CW - 2 * PAD;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = INK; g.font = `700 40px ${MONO}`;
    g.fillText(clip(g, eventInfo?.title || 'Event', full), CW / 2, 150);
    if (eventInfo?.speaker) { g.fillStyle = INK_DIM; g.font = `400 27px ${SANS}`; g.fillText(clip(g, `with ${eventInfo.speaker}`, full), CW / 2, 196); }
    let y = 280;
    button('evt-ticket', PAD, y, full, 78, 'Get a ticket', { accent: true }); y += 96;
    button('evt-zap', PAD, y, full, 74, 'Welcome zap ⚡ 210'); y += 92;
    button('evt-ghost', PAD, y, full, 74, 'Continue as ghost', { dim: true });
  }

  function renderEmotes() {
    title('EMOTES', 'tap to express');
    button('back', PAD, 28, 150, 52, '‹ Back');
    const es = state.emotes ? state.emotes() : [];
    const cols = 2, gap = 16, bw = (CW - 2 * PAD - (cols - 1) * gap) / cols, bh = 110;
    const LABEL = { wave: 'Wave', clap: 'Clap', thumbsup: 'Thumbs up', point: 'Point' };
    es.forEach((e, i) => {
      const c = i % cols, r = (i - c) / cols;
      button(`emote:${e.kind}`, PAD + c * (bw + gap), 150 + r * (bh + gap), bw, bh, `${e.emoji} ${LABEL[e.kind] || e.kind}`, { big: false });
    });
  }

  function renderSpeakers() {
    title('WHICH SPEAKER?', 'panel — tap to zap');
    button('back', PAD, 28, 150, 52, '‹ Back');
    const spks = state.zapSpeakers ? state.zapSpeakers() : [];
    let y = 150; const full = CW - 2 * PAD;
    for (const s of spks) { button(`zap-spk:${s.pubkey}`, PAD, y, full, 74, `⚡ ${s.label}`, { accent: true }); y += 88; }
  }

  function renderRequests() {
    title('TALK REQUESTS', 'Networking · mutual permission');
    button('back', PAD, 28, 150, 52, '‹ Back');
    const reqs = state.talkRequests ? state.talkRequests() : [];
    if (!reqs.length) {
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = INK_DIM; g.font = `400 30px ${SANS}`;
      g.fillText('No pending requests', CW / 2, 280);
      return;
    }
    let y = 150; const full = CW - 2 * PAD, bw = (full - 16) / 2;
    for (const r of reqs) {
      g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = INK; g.font = `600 30px ${MONO}`;
      g.fillText(clip(g, `${r.name || 'Someone'} wants to talk`, full - 20), PAD + 4, y + 18);
      button(`req-accept:${r.id}`, PAD, y + 44, bw, 60, 'Accept', { accent: true });
      button(`req-decline:${r.id}`, PAD + bw + 16, y + 44, bw, 60, 'Decline', { danger: true });
      y += 132;
    }
  }

  function renderTickets() {
    title('GET A TICKET', state.eventTitle() ? `for ${state.eventTitle()}` : 'event-scoped');
    button('back', PAD, 28, 150, 52, '‹ Back');
    const order = ['basic', 'supporter', 'patron'];
    const cur = state.tier();
    let y = 150;
    const full = CW - 2 * PAD, h = 190;
    for (const t of order) {
      const tier = state.tiers[t], sp = state.split(t);
      const isCur = cur === t;
      const rect = { id: `tier:${t}`, x: PAD, y, w: full, h };
      buttons.push(rect);
      const hot = hovered === rect.id;
      roundRect(g, rect.x, rect.y, rect.w, rect.h, 18);
      g.fillStyle = hot ? HOVER_BG : BTN_BG; g.fill();
      g.lineWidth = 2.5; g.strokeStyle = isCur ? VIOLET : (hot ? BITCOIN : BTN_LINE); g.stroke();
      g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillStyle = INK; g.font = `700 40px ${MONO}`;
      g.fillText(tier.label, rect.x + 24, rect.y + 20);
      g.fillStyle = BITCOIN; g.font = `700 34px ${MONO}`;
      g.textAlign = 'right'; g.fillText(`⚡ ${fmt(tier.price)}`, rect.x + rect.w - 24, rect.y + 24);
      g.textAlign = 'left'; g.fillStyle = INK_DIM; g.font = `400 26px ${SANS}`;
      g.fillText(`+${fmt(sp.credits)} spendable credits`, rect.x + 24, rect.y + 74);
      g.fillStyle = INK_DIM; g.font = `400 25px ${SANS}`;
      g.fillText(clip(g, PERKS[t], rect.w - 48), rect.x + 24, rect.y + 112);
      if (isCur) { g.fillStyle = VIOLET; g.font = `600 24px ${MONO}`; g.fillText('● current', rect.x + 24, rect.y + 150); }
      y += h + 18;
    }
  }

  function renderKeypad() {
    title('ENTER CODE', 'from the phone / desktop sign-in');
    button('back', PAD, 28, 150, 52, '‹ Back');

    // Code display: six slots, filled digits then underscores.
    const slots = [];
    for (let i = 0; i < 6; i++) slots.push(i < codeBuf.length ? codeBuf[i] : '_');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = INK; g.font = `700 72px ${MONO}`;
    g.fillText(slots.join(' '), CW / 2, 168);

    // 3×4 keypad grid.
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'submit'];
    const cols = 3, gap = 18;
    const gw = (CW - 2 * PAD - (cols - 1) * gap) / cols;
    const gh = 108;
    const top = 236;
    keys.forEach((k, i) => {
      const c = i % cols, r = (i - c) / cols;
      const x = PAD + c * (gw + gap), y = top + r * (gh + gap);
      const label = k === 'del' ? '⌫' : k === 'submit' ? '✓' : k;
      button(`key:${k}`, x, y, gw, gh, label, { big: true, accent: k === 'submit', danger: k === 'del' });
    });
  }

  // Draw + register a button rect; hover highlight comes from `hovered`.
  function button(id, x, y, w, h, label, opts = {}) {
    buttons.push({ id, x, y, w, h });
    const hot = hovered === id;
    roundRect(g, x, y, w, h, 14);
    g.fillStyle = hot ? HOVER_BG : (opts.accent ? 'rgba(247,147,26,0.16)' : BTN_BG); g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = hot ? BITCOIN : (opts.danger ? 'rgba(255,120,120,0.5)' : (opts.accent ? BITCOIN : BTN_LINE));
    g.stroke();
    g.textBaseline = 'middle';
    g.fillStyle = opts.dim ? INK_DIM : INK;
    g.font = `${opts.big ? 700 : 600} ${opts.big ? 52 : 30}px ${MONO}`;
    if (opts.right) {
      g.textAlign = 'left'; g.fillText(clip(g, label, w - 260), x + 22, y + h / 2);
      g.textAlign = 'right'; g.fillStyle = opts.accent ? BITCOIN : INK_DIM; g.font = `600 25px ${MONO}`;
      g.fillText(opts.right, x + w - 22, y + h / 2);
    } else {
      g.textAlign = 'center'; g.fillText(clip(g, label, w - 24), x + w / 2, y + h / 2);
    }
  }

  // Draw + register a toggle (on = orange fill pill on the right).
  function toggle(id, x, y, w, h, label, on, compact = false) {
    buttons.push({ id, x, y, w, h });
    const hot = hovered === id;
    roundRect(g, x, y, w, h, 12);
    g.fillStyle = hot ? HOVER_BG : BTN_BG; g.fill();
    g.lineWidth = 2; g.strokeStyle = hot ? BITCOIN : BTN_LINE; g.stroke();
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = INK; g.font = `600 ${compact ? 22 : 27}px ${compact ? SANS : MONO}`;
    g.fillText(clip(g, label, w - (compact ? 24 : 96)), x + 16, y + h / 2 - (compact ? 10 : 0));
    // pill
    const pw = compact ? w - 32 : 68, ph = compact ? 14 : 30;
    const px = compact ? x + 16 : x + w - pw - 16, py = compact ? y + h - ph - 10 : y + (h - ph) / 2;
    roundRect(g, px, py, pw, ph, ph / 2);
    g.fillStyle = on ? ON_BG : 'rgba(255,255,255,0.14)'; g.fill();
    if (!compact) {
      g.beginPath(); g.arc(on ? px + pw - ph / 2 : px + ph / 2, py + ph / 2, ph / 2 - 3, 0, Math.PI * 2);
      g.fillStyle = '#0b0d13'; g.fill();
    }
  }

  function dispose() {
    closeMenu();
    scene.remove(group);
    panel.geometry.dispose();
    texture.dispose();
    material.dispose();
  }

  return {
    open: openMenu, close: closeMenu, toggle, isOpen: () => open,
    openSpeakers: () => { if (!open) openMenu(); page = 'speakers'; notice = ''; render(); },
    openEvent: (info) => { eventInfo = info || null; if (!open) openMenu(); page = 'event'; notice = ''; render(); },
    targets, pressWorld, hoverAt, update, dispose,
  };
}

const COMFORT_LABEL = { vignette: 'Vignette', snapTurn: 'Snap turn', haptics: 'Haptics' };
const PERKS = {
  basic: 'Embodied · comment · join the mic queue',
  supporter: 'Basic + Networking & Smoking zones + badge',
  patron: 'Supporter + front row + sponsor spot',
};

const fmt = (n) => Number(n).toLocaleString('en-US');
function clip(g, text, maxW) {
  let t = String(text ?? '');
  if (g.measureText(t).width <= maxW) return t;
  while (t.length && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
