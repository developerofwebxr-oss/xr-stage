import * as THREE from 'three';

// room/scene.js — builds the static spatial stage: floor, stage platform, backdrop
// screen, lights, and a simple sky. Returns the pieces other modules need to touch
// (the backdrop is a seam for future slides; setARMode toggles passthrough).
//
// Keep this LIGHT — no loaded assets, all primitives — so it holds 60fps+ on a
// Quest and on mobile. Units are metres; the floor is centred on the origin and
// the stage sits a few metres in front of -Z (the default "look" direction).

const BITCOIN = 0xf7931a;

export function buildScene() {
  const scene = new THREE.Scene();

  // Background + matching fog so the floor grid fades out instead of ending in a
  // hard line. We stash the colour so AR mode can swap to transparent and back.
  const skyColor = new THREE.Color(0x0a0c14);
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, 18, 55);

  // ── Lights ──────────────────────────────────────────────────────────────────
  // Ambient fills shadows; one directional key gives capsules a sense of form.
  scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x10121a, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(4, 10, 6);
  scene.add(key);

  // ── Floor ───────────────────────────────────────────────────────────────────
  // A dark disc + a grid overlay reads as a venue floor and gives motion cues.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(30, 64),
    new THREE.MeshStandardMaterial({ color: 0x0e1018, roughness: 1, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const grid = new THREE.GridHelper(60, 60, 0x2a2f45, 0x171b2a);
  grid.position.y = 0.01; // avoid z-fighting with the floor disc
  scene.add(grid);

  // ── Stage platform ───────────────────────────────────────────────────────────
  // A low cylinder a few metres in front of the spawn point (-Z). STAGE_POS is
  // exported so the voice layer can spatialise the speaker here later.
  const stage = new THREE.Mesh(
    new THREE.CylinderGeometry(3, 3.2, 0.4, 48),
    new THREE.MeshStandardMaterial({ color: 0x161a28, roughness: 0.8, metalness: 0.1 }),
  );
  stage.position.copy(STAGE_POS).setY(0.2);
  scene.add(stage);

  // A subtle bitcoin-orange rim glow ring around the stage edge.
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(3.1, 0.04, 12, 64),
    new THREE.MeshBasicMaterial({ color: BITCOIN }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(STAGE_POS.x, 0.41, STAGE_POS.z);
  scene.add(rim);

  // ── Backdrop screen ───────────────────────────────────────────────────────────
  // A big plane behind the stage. SEAM: future prompts render slides / generated
  // stage skins onto this material's map. For now it's a flat dark panel + frame.
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 5.6),
    new THREE.MeshStandardMaterial({ color: 0x0c0e16, roughness: 1, emissive: 0x05060a }),
  );
  backdrop.position.set(STAGE_POS.x, 3.2, STAGE_POS.z - 3.4);
  scene.add(backdrop);

  // Cheap frame: an EdgesGeometry outline around the backdrop plane.
  const frameLines = new THREE.LineSegments(
    new THREE.EdgesGeometry(backdrop.geometry),
    new THREE.LineBasicMaterial({ color: 0x2a2f45 }),
  );
  frameLines.position.copy(backdrop.position);
  scene.add(frameLines);

  // ── AR passthrough toggle ──────────────────────────────────────────────────────
  // In AR we want the real world visible, so hide the sky/floor disc and drop fog.
  // Returns the scene to its lit-room look when AR ends.
  function setARMode(on) {
    scene.background = on ? null : skyColor;
    scene.fog = on ? null : new THREE.Fog(skyColor, 18, 55);
    floor.visible = !on;       // the real floor shows through instead
    grid.visible = !on;
    backdrop.visible = !on;    // keep AR uncluttered; stage + avatars remain
    frameLines.visible = !on;
  }

  return { scene, backdrop, stagePos: STAGE_POS.clone(), setARMode };
}

// Stage centre, in world space. Exported so voice/presence can reference it.
export const STAGE_POS = new THREE.Vector3(0, 0, -7);
