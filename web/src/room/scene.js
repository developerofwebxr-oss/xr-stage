import * as THREE from 'three';
import {
  STAGE_POS, STAGE_RADIUS, STAGE_TOP_Y, MIC_PLATFORM_TOP,
  MIC_PLATFORM_W, MIC_PLATFORM_BACK_Z, MIC_PLATFORM_FRONT_Z,
  SCREEN, MIC_STAND_POS, QUESTIONER_POS, AUDIENCE_RADIUS,
} from './zones.js';

// room/scene.js — builds the static venue from the zone constants in zones.js:
// a TWO-LEVEL stage (a raised main stage + a connected step-down mic platform in
// front of it), a framed backdrop screen above/behind, the mic stand on the lower
// platform, plus floor, grid, lights and sky. All primitives, no loaded assets, to
// hold 60fps+ on Quest/mobile.
//
// MOOD: the stage is the bright focal point (emissive top + one aimed SpotLight),
// the floor is dim (dark material + low ambient), orange rings radiate out across
// the floor, and a Points starfield twinkles overhead. Animation is GPU-driven
// (shader uTime) and respects prefers-reduced-motion. No real-time shadow maps
// (too costly on Quest) — grounding is a faked soft radial decal under the stage.
//
// buildScene() returns { scene, backdrop, setARMode, update }. update(dt) advances
// the shader clocks; main.js calls it once per frame.
//
// setARMode toggles the passthrough look (hide sky/floor/screen, keep the venue +
// the radiating floor rings, which read fine anchored to the real floor).

const BITCOIN = 0xf7931a;
const REDUCE_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function buildScene() {
  const scene = new THREE.Scene();

  const skyColor = new THREE.Color(0x05060c);
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, 22, 60);

  // ── Lights ──────────────────────────────────────────────────────────────────
  // Moderate ambient so the crowd reads — audience faces/bodies/colours are clearly
  // visible from the stage — without flattening the mood; a soft side fill shapes
  // them. One warm SpotLight keeps the stage the brightest thing in the room, and a
  // cool backlight rims whoever's on stage off the dark screen. No shadow maps
  // (Quest cost); four cheap lights total, none casting.
  scene.add(new THREE.HemisphereLight(0x7e93d6, 0x0a0c14, 0.6));
  const fill = new THREE.DirectionalLight(0x9fb4ff, 0.4);
  fill.position.set(-6, 9, 6);
  scene.add(fill);

  // Stage key — warm, aimed down at the stage. decay 0 = no falloff (predictable).
  const spot = new THREE.SpotLight(0xffe6c0, 4.2, 0, Math.PI / 6, 0.5, 0);
  spot.position.set(STAGE_POS.x, STAGE_TOP_Y + 10, STAGE_POS.z + 3);
  spot.target.position.set(STAGE_POS.x, STAGE_TOP_Y, STAGE_POS.z);
  scene.add(spot);
  scene.add(spot.target);

  // Stage backlight/rim — cool, from behind + above the stage aiming forward, so a
  // speaker is rim-lit and reads as separate from the dark backdrop screen.
  // Directional = cheap (no position falloff, no shadow).
  const back = new THREE.DirectionalLight(0xbfd0ff, 0.7);
  back.position.set(STAGE_POS.x, STAGE_TOP_Y + 6, STAGE_POS.z - 9);
  back.target.position.set(STAGE_POS.x, STAGE_TOP_Y + 0.5, STAGE_POS.z + 1.5);
  scene.add(back);
  scene.add(back.target);

  // ── Faux light-beam cone (Screen + VR only) ─────────────────────────────────────
  // A translucent additive cone from above the stage, brightest near the source and
  // fading to nothing at the floor — a concert/venue beam without real volumetrics.
  // Single open-ended mesh, depthWrite off. Hidden in AR (would float in passthrough).
  const BEAM_H = STAGE_TOP_Y + 9.5;
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(STAGE_RADIUS * 1.05, BEAM_H, 40, 1, true),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(0xffe6c0) } },
      vertexShader: `
        varying float vY;                              // 1 at apex (source) → 0 at base (floor)
        void main() {
          vY = position.y / ${BEAM_H.toFixed(2)} + 0.5;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;
        varying float vY;
        uniform vec3 uColor;
        void main() {
          float a = pow(clamp(vY, 0.0, 1.0), 1.6) * 0.12; // fade toward the floor
          gl_FragColor = vec4(uColor, a);
        }
      `,
    }),
  );
  beam.position.set(STAGE_POS.x, BEAM_H / 2, STAGE_POS.z);
  scene.add(beam);

  // ── Floor ───────────────────────────────────────────────────────────────────
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(34, 64),
    new THREE.MeshStandardMaterial({ color: 0x070910, roughness: 1, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const grid = new THREE.GridHelper(68, 68, 0x1a1f33, 0x0c0f1a);
  grid.position.y = 0.01;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  // ── Radiating floor rings (GPU shader) ─────────────────────────────────────────
  // Concentric orange rings emanating from the stage centre, fading with distance,
  // slowly spreading outward. One transparent ring-mesh + one shader = cheap; the
  // animation is the uTime uniform (frozen when prefers-reduced-motion is set).
  const ringMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(BITCOIN) } },
    vertexShader: `
      varying float vDist;
      void main() {
        vDist = length(position.xy);          // RingGeometry lies in its local XY plane
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision mediump float;
      varying float vDist;
      uniform float uTime;
      uniform vec3 uColor;
      const float INNER = ${STAGE_RADIUS.toFixed(1)};
      const float OUTER = ${(AUDIENCE_RADIUS + 3).toFixed(1)};
      void main() {
        float wave = sin(vDist * 1.0 - uTime * 0.8);   // travels outward as uTime grows
        float band = smoothstep(0.55, 1.0, wave);       // thin bright rings
        float fade = pow(1.0 - clamp((vDist - INNER) / (OUTER - INNER), 0.0, 1.0), 1.5);
        float a = band * fade * 0.5;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  const rings = new THREE.Mesh(
    new THREE.RingGeometry(STAGE_RADIUS, AUDIENCE_RADIUS + 3, 96, 1),
    ringMat,
  );
  rings.rotation.x = -Math.PI / 2;
  rings.position.set(STAGE_POS.x, 0.03, STAGE_POS.z);
  scene.add(rings);

  // ── Faked contact shadow: a soft dark radial decal grounding the stage base ─────
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(STAGE_RADIUS * 1.7, 48),
    new THREE.MeshBasicMaterial({
      map: radialShadowTexture(), transparent: true, depthWrite: false, opacity: 0.7,
      color: 0x000000, blending: THREE.NormalBlending,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(STAGE_POS.x, 0.018, STAGE_POS.z);
  scene.add(shadow);

  // ── Starfield sky (Points + GPU flicker) ───────────────────────────────────────
  const sky = makeStarfield();
  scene.add(sky.points);

  // ── Two-level stage: raised main stage + connected step-down mic platform ───────
  const stageMat = new THREE.MeshStandardMaterial({ color: 0x161a28, roughness: 0.8, metalness: 0.1 });

  // Main stage: a solid raised cylinder (top at STAGE_TOP_Y).
  const slab = new THREE.Mesh(
    new THREE.CylinderGeometry(STAGE_RADIUS, STAGE_RADIUS + 0.15, STAGE_TOP_Y, 56),
    stageMat,
  );
  slab.position.set(STAGE_POS.x, STAGE_TOP_Y / 2, STAGE_POS.z);
  scene.add(slab);

  // Emissive stage surface — the illuminated focal disc on the main-stage top. The
  // emissive guarantees it stays the brightest read even with ambient dimmed; the
  // SpotLight above adds a warm highlight on top (and on whoever stands here).
  const stageTop = new THREE.Mesh(
    new THREE.CircleGeometry(STAGE_RADIUS * 0.97, 56),
    new THREE.MeshStandardMaterial({
      color: 0x241d12, emissive: 0x5a3c12, emissiveIntensity: 0.85, roughness: 0.5, metalness: 0.1,
    }),
  );
  stageTop.rotation.x = -Math.PI / 2;
  stageTop.position.set(STAGE_POS.x, STAGE_TOP_Y + 0.006, STAGE_POS.z);
  scene.add(stageTop);

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
  // + avatars) so it stays anchored in the real room. The starfield is hidden too —
  // a sky dome would occlude the real world. The radiating floor rings stay: they
  // read fine projected on the real floor and reinforce the stage focal point.
  function setARMode(on) {
    scene.background = on ? null : skyColor;
    scene.fog = on ? null : new THREE.Fog(skyColor, 22, 60);
    floor.visible = !on;
    grid.visible = !on;
    backdrop.visible = !on;
    frame.visible = !on;
    border.visible = !on;
    sky.points.visible = !on;
    beam.visible = !on; // follows the sky rule — no light shaft floating in passthrough
  }

  // ── Per-frame tick (shader clocks) ──────────────────────────────────────────────
  // Drives the ring spread + star flicker. Frozen entirely under prefers-reduced-
  // motion: the rings render as a static pattern and stars hold a fixed brightness.
  let elapsed = 0;
  function update(dt) {
    if (REDUCE_MOTION) return;
    elapsed += dt;
    ringMat.uniforms.uTime.value = elapsed;
    sky.material.uniforms.uTime.value = elapsed;
  }

  return { scene, backdrop, setARMode, update };
}

// A soft black radial-gradient texture for the faked contact shadow under the stage
// (opaque-ish core → transparent edge). One small canvas texture, no assets.
function radialShadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.0, 'rgba(0,0,0,1)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.5)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A Points starfield on a large sphere with per-star GPU flicker. One draw call;
// each star carries a random phase + twinkle rate so brightness varies in the
// fragment shader (no CPU per-star work). ShaderMaterial ignores scene.fog, so the
// stars (well beyond the fog far plane) stay crisp against the dark background.
function makeStarfield() {
  const COUNT = 1400;
  const RADIUS = 90;
  const pos = new Float32Array(COUNT * 3);
  const size = new Float32Array(COUNT);
  const phase = new Float32Array(COUNT);
  const rate = new Float32Array(COUNT);

  // Deterministic scatter (no Math.random — keep the build reproducible): a cheap
  // hash-based point distribution over the sphere.
  for (let i = 0; i < COUNT; i++) {
    const u = frac(Math.sin(i * 12.9898) * 43758.5453);
    const v = frac(Math.sin(i * 78.233) * 23421.6312);
    const theta = u * Math.PI * 2;          // azimuth
    const y = v * 1.4 - 0.4;                 // bias upward (most stars overhead)
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    pos[i * 3] = Math.cos(theta) * r * RADIUS;
    pos[i * 3 + 1] = y * RADIUS;
    pos[i * 3 + 2] = Math.sin(theta) * r * RADIUS;
    size[i] = 1.2 + frac(Math.sin(i * 3.17) * 91.7) * 2.2;
    phase[i] = frac(Math.sin(i * 5.71) * 51.3) * Math.PI * 2;
    rate[i] = 0.6 + frac(Math.sin(i * 9.13) * 17.9) * 1.8;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aRate', new THREE.BufferAttribute(rate, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xcdd8ff) } },
    vertexShader: `
      attribute float aSize;
      attribute float aPhase;
      attribute float aRate;
      uniform float uTime;
      varying float vTw;
      void main() {
        vTw = 0.55 + 0.45 * sin(uTime * aRate + aPhase);   // per-star flicker
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize;
      }
    `,
    fragmentShader: `
      precision mediump float;
      uniform vec3 uColor;
      varying float vTw;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, r) * vTw;           // round, soft-edged
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  const points = new THREE.Points(geo, material);
  points.frustumCulled = false; // it surrounds the camera
  return { points, material };
}

const frac = (n) => n - Math.floor(n);
