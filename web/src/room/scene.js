import * as THREE from 'three';
import {
  STAGE_POS, STAGE_RADIUS, STAGE_TOP_Y, MIC_PLATFORM_TOP,
  MIC_PLATFORM_W, MIC_PLATFORM_BACK_Z, MIC_PLATFORM_FRONT_Z,
  SCREEN, MIC_STAND_POS, QUESTIONER_POS,
} from './zones.js';

// room/scene.js — builds the static venue from the zone constants in zones.js:
// a TWO-LEVEL stage (a raised main stage + a connected step-down mic platform in
// front of it), a framed backdrop screen above/behind, the mic stand on the lower
// platform, plus floor, grid, lights and sky. All primitives, no loaded assets, to
// hold 60fps+ on Quest/mobile.
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

  // ── Two-level stage: raised main stage + connected step-down mic platform ───────
  const stageMat = new THREE.MeshStandardMaterial({ color: 0x161a28, roughness: 0.8, metalness: 0.1 });

  // Main stage: a solid raised cylinder (top at STAGE_TOP_Y).
  const slab = new THREE.Mesh(
    new THREE.CylinderGeometry(STAGE_RADIUS, STAGE_RADIUS + 0.15, STAGE_TOP_Y, 56),
    stageMat,
  );
  slab.position.set(STAGE_POS.x, STAGE_TOP_Y / 2, STAGE_POS.z);
  scene.add(slab);

  // Mic platform: a solid box one step down, joined to the stage front (it tucks
  // under the stage by PLATFORM_OVERLAP so they read as one tiered structure; the
  // stage's front wall above the platform top IS the step riser).
  const platDepth = MIC_PLATFORM_FRONT_Z - MIC_PLATFORM_BACK_Z;
  const platform = new THREE.Mesh(
    new THREE.BoxGeometry(MIC_PLATFORM_W, MIC_PLATFORM_TOP, platDepth),
    stageMat,
  );
  platform.position.set(STAGE_POS.x, MIC_PLATFORM_TOP / 2, (MIC_PLATFORM_BACK_Z + MIC_PLATFORM_FRONT_Z) / 2);
  scene.add(platform);

  // Bitcoin-orange edge glows: the main-stage rim + the mic-platform front lip.
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(STAGE_RADIUS, 0.05, 12, 80),
    new THREE.MeshBasicMaterial({ color: BITCOIN }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(STAGE_POS.x, STAGE_TOP_Y + 0.01, STAGE_POS.z);
  scene.add(rim);

  const lip = new THREE.Mesh(
    new THREE.BoxGeometry(MIC_PLATFORM_W, 0.05, 0.06),
    new THREE.MeshBasicMaterial({ color: BITCOIN }),
  );
  lip.position.set(STAGE_POS.x, MIC_PLATFORM_TOP + 0.005, MIC_PLATFORM_FRONT_Z);
  scene.add(lip);

  // ── Mic stand on the lower platform (questioner faces the speaker here) ──────────
  const pedestal = new THREE.Group();
  pedestal.position.copy(MIC_STAND_POS); // base sits on the platform top
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 0.45, 0.3, 24),
    new THREE.MeshStandardMaterial({ color: 0x1a1f30, roughness: 0.7, metalness: 0.2 }),
  );
  base.position.y = 0.15;
  pedestal.add(base);
  const stand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 1.15, 12),
    new THREE.MeshStandardMaterial({ color: 0x2a3047, roughness: 0.5, metalness: 0.4 }),
  );
  stand.position.y = 0.3 + 0.575;
  pedestal.add(stand);
  const micHead = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x0c0e16, roughness: 0.6 }),
  );
  micHead.position.y = 0.3 + 1.15;
  pedestal.add(micHead);
  scene.add(pedestal);

  // Highlight ring marking where the questioner stands (in front of the mic).
  const marker = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.03, 10, 40),
    new THREE.MeshBasicMaterial({ color: BITCOIN }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.set(QUESTIONER_POS.x, MIC_PLATFORM_TOP + 0.02, QUESTIONER_POS.z);
  scene.add(marker);

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
  // Hide the sky/floor/screen for passthrough; keep the venue (stage + mic platform
  // + avatars) so it stays anchored in the real room.
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
