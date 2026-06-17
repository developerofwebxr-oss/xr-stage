import * as THREE from 'three';
import {
  STAGE_POS, STAGE_RADIUS, STAGE_TOP_Y,
  SCREEN, PEDESTAL_POS,
} from './zones.js';

// room/scene.js — builds the static venue from the zone constants in zones.js:
// a low, SOLID stage platform, a framed backdrop screen above/behind it, the
// questioner's mic stand beside the front, plus floor, grid, lights and sky. All
// primitives, no loaded assets, to hold 60fps+ on Quest/mobile.
//
// setARMode toggles the passthrough look (hide sky/floor/screen, keep the venue).

const BITCOIN = 0xf7931a;

export function buildScene() {
  const scene = new THREE.Scene();

  const skyColor = new THREE.Color(0x0a0c14);
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, 22, 60);

  // ── Lights ──────────────────────────────────────────────────────────────────
  scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x10121a, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(4, 12, 8);
  scene.add(key);

  // ── Floor ───────────────────────────────────────────────────────────────────
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(34, 64),
    new THREE.MeshStandardMaterial({ color: 0x0e1018, roughness: 1, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const grid = new THREE.GridHelper(68, 68, 0x2a2f45, 0x171b2a);
  grid.position.y = 0.01;
  scene.add(grid);

  // ── Stage platform (low + solid) ───────────────────────────────────────────────
  // A solid cylinder from the floor up to STAGE_TOP_Y — no cavity beneath.
  const slab = new THREE.Mesh(
    new THREE.CylinderGeometry(STAGE_RADIUS, STAGE_RADIUS + 0.15, STAGE_TOP_Y, 56),
    new THREE.MeshStandardMaterial({ color: 0x161a28, roughness: 0.8, metalness: 0.1 }),
  );
  slab.position.set(STAGE_POS.x, STAGE_TOP_Y / 2, STAGE_POS.z);
  scene.add(slab);

  // Bitcoin-orange rim glow around the stage-top edge.
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(STAGE_RADIUS, 0.05, 12, 80),
    new THREE.MeshBasicMaterial({ color: BITCOIN }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(STAGE_POS.x, STAGE_TOP_Y + 0.01, STAGE_POS.z);
  scene.add(rim);

  // ── Mic stand (questioner's spot; call-up logic is Phase 3) ─────────────────────
  const pedestal = new THREE.Group();
  pedestal.position.copy(PEDESTAL_POS);
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.5, 0.35, 24),
    new THREE.MeshStandardMaterial({ color: 0x1a1f30, roughness: 0.7, metalness: 0.2 }),
  );
  base.position.y = 0.175;
  pedestal.add(base);
  const stand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 1.2, 12),
    new THREE.MeshStandardMaterial({ color: 0x2a3047, roughness: 0.5, metalness: 0.4 }),
  );
  stand.position.y = 0.35 + 0.6;
  pedestal.add(stand);
  const micHead = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x0c0e16, roughness: 0.6 }),
  );
  micHead.position.y = 0.35 + 1.2;
  pedestal.add(micHead);
  const marker = new THREE.Mesh(
    new THREE.TorusGeometry(0.62, 0.03, 10, 40),
    new THREE.MeshBasicMaterial({ color: BITCOIN }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.02;
  pedestal.add(marker);
  scene.add(pedestal);

  // ── Backdrop screen (larger, framed, above + behind the stage) ─────────────────
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN.w, SCREEN.h),
    new THREE.MeshStandardMaterial({ color: 0x0c0e16, roughness: 1, emissive: 0x06070d }),
  );
  backdrop.position.set(STAGE_POS.x, SCREEN.y, SCREEN.z);
  scene.add(backdrop);

  // Frame: a slightly larger panel behind the screen + a bright orange edge border.
  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN.w + 0.6, SCREEN.h + 0.6),
    new THREE.MeshStandardMaterial({ color: 0x20283c, roughness: 0.6, metalness: 0.3 }),
  );
  frame.position.set(STAGE_POS.x, SCREEN.y, SCREEN.z - 0.05);
  scene.add(frame);
  const border = new THREE.LineSegments(
    new THREE.EdgesGeometry(backdrop.geometry),
    new THREE.LineBasicMaterial({ color: BITCOIN, transparent: true, opacity: 0.5 }),
  );
  border.position.copy(backdrop.position).setZ(SCREEN.z + 0.01);
  scene.add(border);

  // ── AR passthrough toggle ──────────────────────────────────────────────────────
  // Hide the sky/floor/screen for passthrough; keep the venue (stage + green room +
  // pedestal + avatars) so it stays anchored in the real room.
  function setARMode(on) {
    scene.background = on ? null : skyColor;
    scene.fog = on ? null : new THREE.Fog(skyColor, 22, 60);
    floor.visible = !on;
    grid.visible = !on;
    backdrop.visible = !on;
    frame.visible = !on;
    border.visible = !on;
  }

  return { scene, backdrop, setARMode };
}
