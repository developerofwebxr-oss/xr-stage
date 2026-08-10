import * as THREE from 'three';
import { drawKeyface } from '../identity/keyface.js';

// room/commentBoard.js — two large in-world screens flanking the stage, so comments
// are visible in VR (not just the flat DOM). Cheap enough for Quest 72fps:
//   • Each comment card is a single plane with a CANVAS texture, regenerated ONLY when
//     the card is created (post) or its zap total changes (boost) — never per frame.
//   • The live feed scrolls by moving transforms + fading opacity (no re-texturing).
//   • ~10 card meshes total across both screens; a handful of materials.
//
// RIGHT screen = LIVE feed: recent comments, continuously scrolling up (shared, so
//   everyone sees the same stream — mock is local now, real Nostr later).
// LEFT screen = TOP ZAPPED wall: the most-zapped comments, refreshed slowly.
//
// createCommentBoard(scene, { board }) → { update(dt), pickables(), refresh() }
//   pickables() are the card meshes (userData.commentId) for the unified zap raycast.

const BITCOIN = 0xf7931a;
const SCREEN_W = 4.0, SCREEN_H = 3.6;
const CARD_W = 3.5, CARD_H = 0.8, DY = CARD_H + 0.16;
const FEED_N = 6, WALL_N = 4;
const SCROLL_SPEED = 0.22;                 // m/s upward drift of the live feed (when live)
const TOP_EDGE = SCREEN_H / 2 - 0.18;      // fade/recycle bound inside the frame
const WALL_STICKY_MS = 120_000;            // top wall holds its ranking ~2 min
const IDLE_SNAP_MS = 10_000;               // scrolled-back view snaps to live after ~10s idle
const SCROLL_SMOOTH_HZ = 16;               // easing rate: offset chases its target (higher = snappier, ~0.1s settle)

// Slim in-world scrollbar down the LIVE panel's right edge (Live-Console: dark track,
// subtle orange thumb). Thumb height ∝ window/history; position ∝ offset. Bottom = live.
const SB_W = 0.06;                         // thumb width (m)
const SB_TOP = SCREEN_H / 2 - 0.16, SB_BOTTOM = -SCREEN_H / 2 + 0.16;
const SB_TRACK_H = SB_TOP - SB_BOTTOM;     // usable travel span
const SB_X = SCREEN_W / 2 - 0.14;          // just inside the right frame, clear of the cards
const SB_MIN_THUMB = 0.4;                  // shortest thumb (m) — stays grabbable with deep history

export function createCommentBoard(scene, { board }) {
  const feed = makeScreen('LIVE', 0x0a0e18, BITCOIN);
  feed.group.position.set(7, 2.7, -6.2);
  feed.group.rotation.y = -0.4;            // face the audience, angled inward
  scene.add(feed.group);

  const wall = makeScreen('TOP ZAPPED', 0x140b03, BITCOIN);
  wall.group.position.set(-7, 2.7, -6.2);
  wall.group.rotation.y = 0.4;
  scene.add(wall.group);

  let feedCards = []; // [{ mesh, id }]
  let wallCards = [];
  let lastWallBuild = -Infinity;
  let nowMs = 0; // advanced by update(dt); avoids Date.now for determinism

  // Per-viewer LIVE scroll — CLIENT-LOCAL state (never broadcast, never in the board).
  // feedOffset counts comments back from live (0 = live). It EASES toward feedTarget so a
  // gesture reads like scrolling, not paging: input nudges the target, the rendered offset
  // catches up over ~0.1s (reduced-motion → instant). Rounded for the rendered window.
  let feedOffset = 0, feedTarget = 0, idleMs = 0, builtOffset = -1;
  const feedInt = () => Math.round(feedOffset);
  const maxOffset = () => Math.max(0, board.count() - FEED_N);
  const paused = () => feedTarget > 0.01 || feedOffset > 0.01;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // The "● LIVE" affordance — a chip on YOUR view of the panel, shown only when scrolled
  // back. Tapping it (or ~10s idle) snaps to the live flow. Raycast target (liveChip).
  const liveChip = makeLiveChip();
  liveChip.visible = false;
  feed.group.add(liveChip);

  // Slim scrollbar (track + thumb) down the right edge — a real grabbable window scrollbar.
  const scrollbar = makeScrollbar();
  feed.group.add(scrollbar.group);

  function rebuildFeed() {
    disposeCards(feed.content, feedCards);
    feedCards = board.recent(FEED_N, feedInt()).map((c, i) => {
      const mesh = makeCard(c);
      // Stack newest at the bottom; live ticker scrolls the column upward.
      mesh.position.set(0, -((FEED_N - 1) / 2) * DY + i * DY, 0.03);
      feed.content.add(mesh);
      return { mesh, id: c.id };
    });
    builtOffset = feedInt();
  }

  // Reposition/resize the scrollbar thumb from the current offset. Cheap: one mesh moved +
  // Y-scaled, no canvas work. Hidden when there's nothing to scroll (history ≤ window).
  function updateScrollbar() {
    const max = maxOffset();
    scrollbar.group.visible = max > 0;
    if (max <= 0) return;
    const thumbH = Math.max(SB_MIN_THUMB, (FEED_N / board.count()) * SB_TRACK_H);
    const travel = SB_TRACK_H - thumbH;
    const posFrac = THREE.MathUtils.clamp(feedOffset / max, 0, 1); // 0 = live (bottom)
    scrollbar.thumb.scale.y = thumbH;
    scrollbar.thumb.position.y = SB_BOTTOM + thumbH / 2 + posFrac * travel;
  }

  function rebuildWall() {
    disposeCards(wall.content, wallCards);
    const top = board.top(WALL_N);
    wallCards = top.map((c, i) => {
      const mesh = makeCard(c, { rank: i + 1 });
      mesh.position.set(0, ((top.length - 1) / 2) * DY - i * DY, 0.03);
      wall.content.add(mesh);
      return { mesh, id: c.id };
    });
    lastWallBuild = nowMs;
  }

  // Live feed re-renders on change ONLY while live — a scrolled-back view is frozen so
  // new arrivals don't shift what you're reading (they keep landing in the shared data).
  function onBoardChange() {
    if (!paused()) rebuildFeed();
    if (nowMs - lastWallBuild >= WALL_STICKY_MS) rebuildWall();
  }
  const unsub = board.onChange(onBoardChange);
  rebuildFeed();
  rebuildWall();
  updateScrollbar();

  const edgeFade = (mesh) => { mesh.material.opacity = THREE.MathUtils.clamp((TOP_EDGE + 0.2 - Math.abs(mesh.position.y)) / 0.5, 0, 1); };

  function update(dt) {
    nowMs += dt * 1000;

    // Ease the rendered offset toward the target (or snap, for reduced-motion). Rebuild the
    // window only when the ROUNDED offset crosses an integer — so a multi-step scroll glides
    // through every comment (each rendered for a frame or two, readable) instead of jumping.
    if (reduceMotion.matches) {
      feedOffset = feedTarget;
    } else if (feedOffset !== feedTarget) {
      feedOffset += (feedTarget - feedOffset) * (1 - Math.exp(-SCROLL_SMOOTH_HZ * dt));
      if (Math.abs(feedTarget - feedOffset) < 0.002) feedOffset = feedTarget;
    }
    if (feedInt() !== builtOffset) rebuildFeed();
    liveChip.visible = paused();   // may flip without a rebuild (e.g. easing back to live)
    updateScrollbar();

    if (feedCards.length) {
      if (!paused()) {
        // LIVE: scroll upward, recycle a card past the top, fade the vertical overflow.
        for (const { mesh } of feedCards) mesh.position.y += SCROLL_SPEED * dt;
        for (const { mesh } of feedCards) {
          if (mesh.position.y > TOP_EDGE + CARD_H) {
            const minY = Math.min(...feedCards.map((c) => c.mesh.position.y));
            mesh.position.y = minY - DY;
          }
          edgeFade(mesh);
        }
      } else {
        // SCROLLED BACK: static window; fade overflow; snap to live after idle.
        for (const { mesh } of feedCards) edgeFade(mesh);
        idleMs += dt * 1000;
        if (idleMs >= IDLE_SNAP_MS) snapLive();
      }
    }
    if (nowMs - lastWallBuild >= WALL_STICKY_MS && wallDiffersFromTop()) rebuildWall();
  }

  function wallDiffersFromTop() {
    const top = board.top(WALL_N).map((c) => c.id).join(',');
    return top !== wallCards.map((c) => c.id).join(',');
  }

  // Client-local scroll of MY live view — all input funnels through the TARGET; the render
  // eases to it (update). deltaComments may be fractional (wheel step, drag nudge, VR stick).
  function scrollBy(deltaComments) {
    feedTarget = THREE.MathUtils.clamp(feedTarget + deltaComments, 0, maxOffset());
    idleMs = 0;
  }
  function pageBy(dir) { scrollBy(dir * FEED_N); } // one window up/down (track-tap)

  // Scrollbar-thumb scrub: map a world point on the panel to an offset and jump there
  // DIRECTLY (no easing) so the thumb tracks the finger 1:1. `point` is any ray hit on the
  // panel (thumb, track, or backdrop) — we only use its vertical position along the track.
  const _lp = new THREE.Vector3();
  function scrubToWorld(point) {
    const max = maxOffset();
    if (max <= 0) return;
    feed.group.worldToLocal(_lp.copy(point));
    const thumbH = Math.max(SB_MIN_THUMB, (FEED_N / board.count()) * SB_TRACK_H);
    const travel = SB_TRACK_H - thumbH;
    const centerMin = SB_BOTTOM + thumbH / 2;
    const posFrac = travel > 0 ? THREE.MathUtils.clamp((_lp.y - centerMin) / travel, 0, 1) : 0;
    feedTarget = feedOffset = posFrac * max;
    idleMs = 0;
  }
  // Track-tap above/below the thumb pages one window toward older/newer.
  function pageAtWorld(point) {
    if (maxOffset() <= 0) return;
    feed.group.worldToLocal(_lp.copy(point));
    pageBy(_lp.y > scrollbar.thumb.position.y ? 1 : -1); // above thumb (higher) → older
  }
  function snapLive() { feedTarget = 0; idleMs = 0; } // eases to live; thumb → bottom

  return {
    update,
    // Card meshes for the unified zap raycast (both screens).
    pickables: () => feedCards.concat(wallCards).map((c) => c.mesh),
    // LIVE-panel raycast targets for the scroll gesture (backdrop + cards + the live chip).
    liveTargets: () => [feed.backdrop].concat(feedCards.map((c) => c.mesh), liveChip.visible ? [liveChip] : []),
    // Scrollbar raycast targets (track + thumb) — only while there's history to scroll.
    scrollTargets: () => (scrollbar.group.visible ? [scrollbar.track, scrollbar.thumb] : []),
    isLiveChip: (obj) => obj === liveChip,
    isLivePaused: paused,
    scrollBy, scrollToOffset: (v) => { feedTarget = THREE.MathUtils.clamp(v, 0, maxOffset()); idleMs = 0; },
    scrubToWorld, pageAtWorld, snapLive,
    refresh: onBoardChange,
    dispose() { unsub(); },
  };
}

// The "● LIVE" chip shown on the feed panel while scrolled back (tap → snap to live).
function makeLiveChip() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 96;
  const g = cv.getContext('2d');
  roundRect(g, 4, 4, 248, 88, 44);
  g.fillStyle = 'rgba(12,14,19,0.92)'; g.fill();
  g.strokeStyle = 'rgba(247,147,26,0.7)'; g.lineWidth = 3; g.stroke();
  g.fillStyle = '#f7931a'; g.beginPath(); g.arc(70, 48, 14, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#eceef5'; g.font = '700 40px ui-monospace, Menlo, monospace';
  g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('LIVE', 100, 50);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const chip = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.34),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  chip.position.set(0, SCREEN_H / 2 - 0.28, 0.06);
  chip.renderOrder = 4; // above cards
  chip.userData.liveChip = true;
  return chip;
}

// The slim window scrollbar: a dark track quad + a subtle-orange thumb quad on the panel's
// right edge (Live-Console styling). The thumb is a UNIT-height plane repositioned/​Y-scaled
// each change — no per-frame canvas work. Both are raycast targets (grab / track-tap).
function makeScrollbar() {
  const group = new THREE.Group();
  group.position.z = 0.045; // above the backdrop, clear of the cards' right edge

  const track = new THREE.Mesh(
    new THREE.PlaneGeometry(SB_W * 0.55, SB_TRACK_H + SB_W),
    new THREE.MeshBasicMaterial({ color: 0x0c111b, transparent: true, opacity: 0.6, depthWrite: false }),
  );
  track.position.set(SB_X, 0, 0);
  track.renderOrder = 3;
  track.userData.scrollTrack = true;
  group.add(track);

  const thumb = new THREE.Mesh(
    new THREE.PlaneGeometry(SB_W, 1), // unit height; scaled in Y to the window/history ratio
    new THREE.MeshBasicMaterial({ color: 0xf7931a, transparent: true, opacity: 0.55, depthWrite: false }),
  );
  thumb.position.set(SB_X, 0, 0.01);
  thumb.renderOrder = 4;
  thumb.userData.scrollThumb = true;
  group.add(thumb);

  return { group, track, thumb };
}

// ── One screen: dark glass backdrop + orange frame + a title plate ────────────────
// Panels are SOLID: the backdrop is OPAQUE (writes depth), so the depth buffer handles
// cross-panel occlusion at any angle — one panel's cards can never bleed through another
// panel's backdrop (the 3.11 fix). renderOrder still pins the WITHIN-panel back-to-front
// order (backdrop → frame → cards → title): the opaque backdrop draws in the opaque pass
// first, then cards (transparent, renderOrder 2) draw over it and depth-test against
// everything solid. Row visibility stays view-angle-independent (the 3.7 fix) because
// there's no more camera-distance sort between the backdrop and its cards. Avatars are
// opaque and still occlude cards via depthTest.
function makeScreen(title, bg, accent) {
  const group = new THREE.Group();

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN_W, SCREEN_H),
    new THREE.MeshBasicMaterial({ color: bg }), // opaque (transparent:false, depthWrite:true)
  );
  backdrop.renderOrder = 0;
  group.add(backdrop);

  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H)),
    new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.6 }),
  );
  frame.position.z = 0.01;
  frame.renderOrder = 1;
  group.add(frame);

  // Title plate at the top of the screen.
  const titleTex = new THREE.CanvasTexture(titleCanvas(title));
  titleTex.colorSpace = THREE.SRGBColorSpace;
  const titleMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 0.42),
    new THREE.MeshBasicMaterial({ map: titleTex, transparent: true, depthWrite: false }),
  );
  titleMesh.position.set(0, SCREEN_H / 2 + 0.34, 0.02);
  titleMesh.renderOrder = 3;
  group.add(titleMesh);

  const content = new THREE.Group();
  content.position.z = 0.02;
  group.add(content);

  return { group, content, backdrop };
}

// ── One comment card: keyface + name + wrapped text + ⚡ zapped total ──────────────
function makeCard(comment, { rank } = {}) {
  const tex = new THREE.CanvasTexture(cardCanvas(comment, rank));
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(CARD_W, CARD_H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  mesh.renderOrder = 2;                  // always paint after the screen backdrop (0), any camera angle
  mesh.userData.commentId = comment.id;  // raycast target for zap-to-boost
  return mesh;
}

const CW = 700, CH = 160; // card canvas px (CARD_W:CARD_H ≈ 4.375:1)
function cardCanvas(c, rank) {
  const cv = document.createElement('canvas');
  cv.width = CW; cv.height = CH;
  const g = cv.getContext('2d');

  roundRect(g, 4, 4, CW - 8, CH - 8, 18);
  g.fillStyle = 'rgba(12,14,19,0.9)'; g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 2; g.stroke();

  // keyface (left)
  const face = drawKeyface(c.pubkey, 112);
  g.drawImage(face, 26, CH / 2 - 48, 96, 96);

  const textX = 150;
  // name
  g.fillStyle = '#eceef5';
  g.font = '600 30px ui-monospace, "SF Mono", Menlo, monospace';
  g.textBaseline = 'alphabetic';
  const name = shortName(c.pubkey);
  g.fillText(name, textX, 52);

  // body text (wrap to 2 lines)
  g.fillStyle = 'rgba(236,238,245,0.86)';
  g.font = '400 27px system-ui, -apple-system, sans-serif';
  const lines = wrap(g, c.text, CW - textX - 130, 2);
  lines.forEach((ln, i) => g.fillText(ln, textX, 92 + i * 32));

  // ⚡ zapped total (right)
  g.textAlign = 'right';
  g.fillStyle = '#f7931a';
  g.font = '700 30px ui-monospace, "SF Mono", Menlo, monospace';
  g.fillText(`⚡ ${c.sats.toLocaleString('en-US')}`, CW - 28, 52);
  g.textAlign = 'left';

  // rank badge (top wall only)
  if (rank) {
    g.fillStyle = 'rgba(247,147,26,0.85)';
    g.font = '700 24px ui-monospace, Menlo, monospace';
    g.textAlign = 'right';
    g.fillText(`#${rank}`, CW - 28, CH - 24);
    g.textAlign = 'left';
  }
  return cv;
}

function titleCanvas(title) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 112;
  const g = cv.getContext('2d');
  g.fillStyle = '#f7931a';
  g.font = '700 62px ui-monospace, "SF Mono", Menlo, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(247,147,26,0.5)'; g.shadowBlur = 16;
  g.fillText(title, 256, 60);
  return cv;
}

// A stable short handle from the pubkey (the real name lives on the avatar; cards keep
// it compact and don't need a getProfile round-trip).
function shortName(pubkey) { return `@${pubkey.slice(0, 8)}`; }

function wrap(g, text, maxW, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxW && line) {
      lines.push(line); line = w;
      if (lines.length === maxLines - 1) break;
    } else { line = test; }
  }
  if (line && lines.length < maxLines) lines.push(line);
  // Ellipsise if truncated.
  const used = words.join(' ');
  if (lines.join(' ').length < used.length && lines.length) {
    let last = lines[lines.length - 1];
    while (g.measureText(`${last}…`).width > maxW && last.length) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function disposeCards(contentGroup, list) {
  for (const { mesh } of list) {
    contentGroup.remove(mesh);
    mesh.material.map?.dispose();
    mesh.material.dispose();
    mesh.geometry.dispose();
  }
  list.length = 0;
}
