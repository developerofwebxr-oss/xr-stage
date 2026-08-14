import * as THREE from 'three';

// room/zapEffect.js — in-world "zap bursts", visible in VR too. Two flavours:
//   • spawn(group, amount)  — an avatar zap: ⚡+amount floats up off the person (parented).
//   • fling({position, side, topY, amount}) — a COMMENT-CARD boost: ⚡+amount is flung off
//     the card, slides out past the panel's near edge, arcs upward with a slight curve,
//     and fades above the screen top (~1–1.5s). Spamming boosts reads as an upward rain.
//
// Cheap: each burst is ONE Sprite built on the event and disposed on fade — no per-frame
// canvas redraws, no accumulating meshes. Concurrent bursts are capped (oldest culled).
// update(dt) early-returns when idle (0 cost between zaps → holds Quest 72fps). Respects
// prefers-reduced-motion: a comment boost becomes a brief static fade at the card.
//
//   const fx = createZapEffects(scene);  // scene = where world-space flings are added
//   fx.spawn(avatarGroup, amount) · fx.fling({...}) · fx.update(dt)

const AV_LIFE = 0.9, AV_RISE = 0.9, AV_START_Y = 1.9; // avatar burst
const MAX_ACTIVE = 20;                                 // cap concurrent bursts
const BITCOIN = '#f7931a';
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createZapEffects(scene) {
  const active = [];

  function makeSprite(amount, w, h) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: labelTexture(amount), transparent: true, depthWrite: false, depthTest: false,
    }));
    sprite.scale.set(w, h, 1);
    sprite.renderOrder = 999;
    return sprite;
  }
  function drop(e) {
    (e.group || scene).remove(e.sprite);
    e.sprite.material.map?.dispose();
    e.sprite.material.dispose();
  }
  function cull() { while (active.length >= MAX_ACTIVE) drop(active.shift()); }

  // Avatar zap — parented to the person, floats straight up.
  function spawn(group, amountSats) {
    if (!group) return;
    cull();
    const sprite = makeSprite(amountSats, 1.1, 0.55);
    sprite.position.set(0, AV_START_Y, 0);
    group.add(sprite);
    active.push({ kind: 'avatar', sprite, group, t: 0, life: AV_LIFE });
  }

  // Emote — a floating emoji that rises off the person's head + fades (like an avatar zap).
  function emote(group, emoji) {
    if (!group) return;
    cull();
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture(emoji), transparent: true, depthWrite: false, depthTest: false }));
    sprite.scale.set(0.55, 0.55, 1); sprite.renderOrder = 999;
    sprite.position.set(0, AV_START_Y, 0);
    group.add(sprite);
    active.push({ kind: 'avatar', sprite, group, t: 0, life: 1.3 });
  }

  // 🦩 Feed snack (4.14) — 2–3 tiny cracker sprites arc from `from` to `to` (the bird's head) and
  // dispose on arrival (~0.8s). Reduced motion: a single quick static hop. Cheap, no meshes.
  function snack(from, to, { emoji = '🍪' } = {}) {
    if (!from || !to) return;
    const n = REDUCE ? 1 : 3;
    for (let i = 0; i < n; i++) {
      cull();
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture(emoji), transparent: true, depthWrite: false, depthTest: false }));
      const sc = 0.16 + i * 0.02; sprite.scale.set(sc, sc, 1); sprite.renderOrder = 999;
      sprite.position.copy(from); scene.add(sprite);
      const jitter = new THREE.Vector3((i - 1) * 0.12, i * 0.05, (i - 1) * 0.1);
      active.push({ kind: 'snack', sprite, t: 0, life: (REDUCE ? 0.35 : 0.8) + i * 0.05, from: from.clone(), to: to.clone().add(jitter), arc: REDUCE ? 0.1 : 0.45 + i * 0.12 });
    }
  }

  // 🦩 Reaction burst (4.14) — an emoji sprite pops at a world position, floats up + fades (~1s).
  function burst(pos, emoji, { life = 1.0, rise = 0.7, scale = 0.5 } = {}) {
    if (!pos) return;
    cull();
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture(emoji), transparent: true, depthWrite: false, depthTest: false }));
    sprite.scale.set(scale, scale, 1); sprite.renderOrder = 999;
    sprite.position.copy(pos); scene.add(sprite);
    active.push({ kind: 'wpop', sprite, t: 0, life, rise, y0: pos.y, sc: scale });
  }

  // 🦩 Text burst (4.14) — e.g. the Screamer's jagged "SQUAWK!" sprite. Same rise+fade as burst.
  function burstText(pos, text, { life = 1.1, rise = 0.6, w = 1.0, h = 0.5 } = {}) {
    if (!pos) return;
    cull();
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: shoutTexture(text), transparent: true, depthWrite: false, depthTest: false }));
    sprite.scale.set(w, h, 1); sprite.renderOrder = 999;
    sprite.position.copy(pos); scene.add(sprite);
    active.push({ kind: 'wpop', sprite, t: 0, life, rise, y0: pos.y, sc: w, scH: h });
  }

  // Comment-card boost — flung off the card into world space.
  function fling({ position, side = 'right', topY = 4.5, amount } = {}) {
    if (!position) return;
    cull();
    const sprite = makeSprite(amount, 0.9, 0.45);
    sprite.position.copy(position);
    scene.add(sprite);
    if (REDUCE) { active.push({ kind: 'static', sprite, t: 0, life: 0.6 }); return; }
    const dir = side === 'left' ? -1 : 1;
    active.push({
      kind: 'fling', sprite, t: 0,
      life: 1.1 + Math.random() * 0.4,
      vx: dir * (1.3 + Math.random() * 0.9),   // slide outward
      vy: 0.3 + Math.random() * 0.5,           // initial lift
      ay: 2.8 + Math.random() * 1.4,           // upward accel → the arc
      topY,
    });
  }

  function update(dt) {
    if (!active.length) return; // idle
    for (let i = active.length - 1; i >= 0; i--) {
      const e = active[i];
      e.t += dt;
      const k = Math.min(1, e.t / e.life);
      if (e.kind === 'avatar') {
        e.sprite.position.y = AV_START_Y + AV_RISE * k;
        e.sprite.material.opacity = 1 - k;
        const s = 1 + k * 0.4;
        e.sprite.scale.set(1.1 * s, 0.55 * s, 1);
      } else if (e.kind === 'fling') {
        e.vx *= Math.max(0, 1 - 2.2 * dt);     // slide decays
        e.vy += e.ay * dt;                      // rises faster → curves up
        e.sprite.position.x += e.vx * dt;
        e.sprite.position.y += e.vy * dt;
        let op = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;                 // fade out over the tail
        if (e.sprite.position.y > e.topY) {                         // and as it clears the top
          op = Math.min(op, Math.max(0, 1 - (e.sprite.position.y - e.topY) / 0.8));
        }
        e.sprite.material.opacity = Math.max(0, op);
        const s = 0.9 * (1 + k * 0.3);
        e.sprite.scale.set(s, s * 0.5, 1);
      } else if (e.kind === 'snack') {                 // arc from → to (bird head), fade on arrival
        const p = e.from.clone().lerp(e.to, k); p.y += Math.sin(Math.PI * k) * e.arc;
        e.sprite.position.copy(p);
        e.sprite.material.opacity = k > 0.85 ? 1 - (k - 0.85) / 0.15 : 1;
      } else if (e.kind === 'wpop') {                  // reaction burst: rise + fade at a world pos
        e.sprite.position.y = e.y0 + e.rise * k;
        e.sprite.material.opacity = 1 - k;
        const gs = 1 + k * 0.5; e.sprite.scale.set(e.sc * gs, (e.scH || e.sc) * gs, 1);
      } else { // static (reduced motion)
        e.sprite.material.opacity = 1 - k;
        e.sprite.position.y += 0.15 * dt;
      }
      if (e.t >= e.life) { drop(e); active.splice(i, 1); }
    }
  }

  return { spawn, fling, emote, snack, burst, burstText, update };
}

// A jagged comic "SQUAWK!" shout label → texture (disposed on end).
function shoutTexture(text) {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 160;
  const ctx = c.getContext('2d');
  ctx.font = '900 84px "Arial Black", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 12; ctx.strokeStyle = '#1a0a12';
  ctx.strokeText(text || 'SQUAWK!', 160, 84);
  ctx.fillStyle = '#ff5aa8';
  ctx.fillText(text || 'SQUAWK!', 160, 84);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// One small canvas → texture for an emoji burst (disposed on end).
function emojiTexture(emoji) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.font = '96px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(emoji || '👋', 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// One small canvas → texture per burst (disposed on end). Not per-frame work.
function labelTexture(amountSats) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 62px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = BITCOIN;
  ctx.fillText(`⚡ ${Number(amountSats).toLocaleString('en-US')}`, 128, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
