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
const SCROLL_SPEED = 0.22;                 // m/s upward drift of the live feed
const TOP_EDGE = SCREEN_H / 2 - 0.18;      // fade/recycle bound inside the frame
const WALL_STICKY_MS = 120_000;            // top wall holds its ranking ~2 min

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

  function rebuildFeed() {
    disposeCards(feed.content, feedCards);
    feedCards = board.recent(FEED_N).map((c, i) => {
      const mesh = makeCard(c);
      // Stack newest at the bottom; the ticker scrolls the column upward.
      mesh.position.set(0, -((FEED_N - 1) / 2) * DY + i * DY, 0.03);
      feed.content.add(mesh);
      return { mesh, id: c.id };
    });
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

  // The live feed re-renders immediately (new comment / new boost total). The top
  // wall is "sticky": it re-ranks at most every ~2 min so entries don't churn.
  function onBoardChange() {
    rebuildFeed();
    if (nowMs - lastWallBuild >= WALL_STICKY_MS) rebuildWall();
  }
  const unsub = board.onChange(onBoardChange);
  rebuildFeed();
  rebuildWall();

  function update(dt) {
    nowMs += dt * 1000;
    // Scroll the live feed upward; recycle a card to the bottom when it clears the top,
    // and fade cards near the vertical edges so the overflow dissolves (no clipping).
    if (feedCards.length) {
      for (const { mesh } of feedCards) mesh.position.y += SCROLL_SPEED * dt;
      for (const { mesh } of feedCards) {
        if (mesh.position.y > TOP_EDGE + CARD_H) {
          const minY = Math.min(...feedCards.map((c) => c.mesh.position.y));
          mesh.position.y = minY - DY;
        }
        const fade = THREE.MathUtils.clamp((TOP_EDGE + 0.2 - Math.abs(mesh.position.y)) / 0.5, 0, 1);
        mesh.material.opacity = fade;
      }
    }
    // Refresh the sticky wall if its hold has elapsed since the last board change.
    if (nowMs - lastWallBuild >= WALL_STICKY_MS && wallDiffersFromTop()) rebuildWall();
  }

  function wallDiffersFromTop() {
    const top = board.top(WALL_N).map((c) => c.id).join(',');
    return top !== wallCards.map((c) => c.id).join(',');
  }

  return {
    update,
    // Card meshes for the unified zap raycast (both screens).
    pickables: () => feedCards.concat(wallCards).map((c) => c.mesh),
    refresh: onBoardChange,
    dispose() { unsub(); },
  };
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

  return { group, content };
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
