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
      } else { // static (reduced motion)
        e.sprite.material.opacity = 1 - k;
        e.sprite.position.y += 0.15 * dt;
      }
      if (e.t >= e.life) { drop(e); active.splice(i, 1); }
    }
  }

  return { spawn, fling, update };
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
