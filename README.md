# XR Stage — WebXR spatial stage (foundation)

One link, four modes. A rendered room you can enter on **phone, desktop, VR, and
AR (passthrough)**, with **live voice** (one speaker → many listeners) carried over
[LiveKit](https://livekit.io).

This repo is the **foundation only**: the four-mode room + voice + a presence
heartbeat. Identity (Nostr), avatars (Keyface), payments / zaps, slot booking, AI,
and sponsor logos all come in later prompts — the seams for them are already in
place (see the bottom of this file).

> A standalone project. Code conventions are inspired by Sats Arena (frontend never
> holds secrets, backend holds the keys, small modules), but this repo shares no
> code, deployment, or infrastructure with it.

## Layout

```
web/      Vite + Three.js client — the WebXR room + LiveKit client (static; GitHub Pages)
  src/
    xr/        session lifecycle (VR/AR enter) + locomotion (4 input styles)
    room/      scene (floor/stage/backdrop/lights) + avatar capsules
    voice/     LiveKit client: join, publish/subscribe audio, data channel
    state/     stageState (shared-state seam) + presence heartbeat
    ui/        DOM HUD overlay
server/   Node/Express token server (Railway). Mints LiveKit tokens; holds the secrets.
```

Shared room state (presence now; stage state / zaps later) rides **LiveKit's data
channel** — there is no separate realtime server.

## Prerequisites

- Node 18+ (developed on Node 24).
- A LiveKit instance — either [LiveKit Cloud](https://cloud.livekit.io) (free tier
  is plenty) or a self-host. You need three values: **URL, API key, API secret**.
  The URL is public; the key + secret are server-only.

## Run locally

**1. Backend** (`server/`) — mints LiveKit tokens, holds the secret:

```bash
cd server
npm install
cp .env.example .env          # fill in LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
npm start                     # → http://localhost:8080
```

Smoke-test the token endpoint:

```bash
curl -X POST http://localhost:8080/token \
  -H 'content-type: application/json' \
  -d '{"room":"main-stage","identity":"alice","role":"speaker"}'
# → {"token":"eyJ...","identity":"alice","role":"speaker","room":"main-stage"}
```

Paste that JWT into <https://jwt.io> — the `video` grant shows `canPublish:true`
for `speaker` and is absent/false for `listener`.

**2. Client** (`web/`):

```bash
cd web
npm install
cp .env.example .env.local    # VITE_LIVEKIT_URL + VITE_TOKEN_URL (the FULL …/token URL)
npm run dev                   # → https://localhost:5173 (self-signed cert — "proceed anyway")
```

> The dev server is **HTTPS** (via `@vitejs/plugin-basic-ssl`) because browsers
> refuse WebXR on plain HTTP, and it binds to `host: true` so a Quest / phone on the
> same WiFi can open the LAN URL (accept the cert warning there too).

### Trying the four modes

| Mode | How |
|------|-----|
| **Desktop** | Open the URL. Click to lock the pointer, mouse to look, **WASD** to move. |
| **Mobile** | Open on a phone. Drag to look, or toggle **Gyro: on** to look by tilting. Walk with the **bottom-left joystick** (up/down = forward/back, left/right = strafe). In AR you also walk physically. |
| **VR** | Open in the **Quest browser**, tap **Enter VR**. Right stick = move, left stick = snap-turn, **X/A** to exit. |
| **AR** | Open on a WebXR phone (Chrome `immersive-ar`), tap **Enter AR**. The room anchors to your floor; walk around. |

### Trying voice + presence

Open the URL in two browsers/devices:

- one as **speaker**: `…/?role=speaker`
- one as **listener**: `…/` (default)

Each side has a role-aware toggle: the listener taps **Listen: off → on** to start
hearing the room (that first tap also satisfies the browser's autoplay gesture);
the speaker taps **Speak: off → on** to publish their mic. The `🎙 N speaking`
indicator and the `voice:` status badge update live, and you'll see the other
person's flat-faced body turn and move in near-real-time as they look / walk around
(presence). Listeners also see a disabled **Request to speak** placeholder (the
raise-hand → zap → pedestal flow is a later phase).

## Deploy

### Client → GitHub Pages

`.github/workflows/deploy.yml` builds `web/` and publishes `web/dist` on every push
to `main`. `base` is relative (`./`), so it works from a project subpath like
`/xr-stage/`. Set two repo **Variables** (Settings → Secrets and variables →
Actions → **Variables**) — neither is a secret:

- `VITE_LIVEKIT_URL` = `wss://your-project.livekit.cloud`
- `VITE_TOKEN_URL` = the **full token endpoint, including `/token`**, e.g.
  `https://xr-stage-production.up.railway.app/token` — the client fetches it
  verbatim and does **not** append `/token` (appending caused a `/token/token` 404).

Then enable Pages (Settings → Pages → Source: GitHub Actions).

### Backend → Railway

Deploy `server/` as its own Railway service (start command `npm start`; Railway
injects `PORT`). Set in the Railway **Variables** tab — never in the repo:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `ALLOWED_ORIGIN` = your Pages origin (comma-separate to add others, e.g. your
  dev `https://localhost:5173`)

Swapping LiveKit Cloud ↔ a self-hosted LiveKit is just changing `LIVEKIT_URL` (and
`VITE_LIVEKIT_URL` on the client) — no code change.

## Guardrails honored here

- **Secrets stay server-side.** The browser only ever receives a short-lived JWT;
  the LiveKit key/secret live in `server/` only.
- **Role gates publish.** `speaker` tokens carry `canPublish`; listeners don't —
  enforced when the token is minted, not trusted from the client.
- Scene is all primitives (no heavy assets) to hold 60fps+ on Quest and mobile.

## Changelog

**Look-hint UX** — no new features:
- The controls hint is now a **transient top-centre badge** (below the status bar,
  no longer covering scene centre): it fades in on load and out after ~4.5s or on
  the first look/move input, and re-flashes briefly when returning to flat mode.
- **Free-look exit discoverability + state-sync:** while Free look is on (desktop
  pointer-lock), a `Free look on — press ESC to exit` hint shows (the cursor is
  captured, so the button can't be clicked). `pointerlockchange` releasing the lock
  (ESC or otherwise) flips the toggle back to off and hides the hint — the UI and
  pointer-lock state never desync.

**Look controls rework** — no new features:
- **Desktop default is hold-left-drag to look** (sats-arena style) — release to stop.
  The old always-on pointer-lock free-look is no longer the default.
- **One unified "Free look" toggle** (replaces "Gyro"), shown on every device.
  OFF (default): hold-drag (desktop) / touch-drag (mobile). ON: pointer-lock free
  mouse (desktop) / gyro (mobile). iOS gyro permission still prompts on the enabling
  tap; if pointer lock drops (Esc) the toggle untoggles itself.
- **Smoothed mobile gyro:** the device-orientation → look mapping is low-pass lerped
  (factor 0.12) toward a target with a sub-degree deadzone, accounts for screen
  orientation (portrait/landscape), and calibrates "forward" to the heading at the
  moment Free look is enabled — no more twitch. One look path feeds rig yaw + camera
  pitch (drag / pointer-lock / gyro all converge there).

**Avatar separation: all bodies + head-safe gap** — no new features:
- Separation now pushes the local player out of **every** body — live participants
  **and** the static seeded props (their positions are returned by
  `seedPlaceholders` and fed into the same `presence.separation()`). Presence is now
  created at startup so this is active even before joining voice (the heartbeat
  still only flows once connected).
- The minimum gap is a single tunable `MIN_BODY_GAP` (in
  [avatars.js](web/src/room/avatars.js)) = `max(head_diameter, body_diameter) +
  epsilon` (0.68m), so **heads never intersect** (they carry the Nostr profile pic)
  — and bodies clear too.

**Geometry + clamp tuning** — no new features:
- Mic platform footprint trimmed a notch (`MIC_PLATFORM_W` 5.0→4.2,
  `MIC_PLATFORM_DEPTH` 3.6→3.0); still joined to the stage with standing room at
  the mic.
- Clamps are now **body-radius aware** (`BODY_RADIUS`): every edge is offset by the
  avatar's radius, so a body stops flush against the stage/platform and never clips
  into the mesh — kept inside by the radius, pushed outside by the radius (speaker,
  next-up, and audience vs. both the stage disc and the platform).
- Lightweight **avatar separation** ([presence.js](web/src/state/presence.js)):
  the local rig is nudged out of any overlapping remote body to a ~0.7m gap
  (local-only positional push, re-clamped to the zone — no physics). Static seeded
  props aren't included yet (noted in code).

**Tiered stage (connected mic platform)** — no new features:
- The stage + mic are now **one connected two-level structure**: a raised main
  stage (`STAGE_TOP_Y`) with a step down (`STEP_HEIGHT`) to a lower **mic platform**
  joined to its front (tucked under the stage, so the stage's front wall is the step
  riser). The mic stand sits on the lower platform with standing room
  (`STAND_CLEARANCE`) in front of it. Footprint/heights are tunable in
  [zones.js](web/src/room/zones.js) (`MIC_PLATFORM_W/_DEPTH`, `STEP_HEIGHT`, …).
- **Zones:** next-up/questioner is now confined to the mic-platform standing area
  (facing the speaker) — replacing the old floor mic-stand spot; its glow is a
  rectangle outline. Audience is kept off **both** the stage and the mic platform
  (unless next-up); the questioner can't wander onto the stage or into the crowd.
  Speaker→stage, audience→floor intact. Single reusable zone source unchanged.

**Stage geometry + mobile UI refinement** — no new features:
- **Lower, solid stage.** Stage is now a low, solid platform (`STAGE_TOP_Y` 0.5) —
  the raised stage + under-stage green room are gone (no cavity). The questioner's
  **mic stand** stays at floor level beside the stage front; the next-up zone now
  targets the mic stand (not an under-stage room), so Phase 3's request-to-speak
  flow sends the selected person there. Speaker→stage and audience→floor clamps
  unchanged.
- **Cleaner control bar.** One centred bottom pill that's a single row on wide
  screens and wraps into **two tidy centred rows** on portrait (modes group + voice
  group — no offset stack, consistent sizes).
- **Joystick** anchored bottom-left and lowered, never overlapping the bar.
- **Gyro toggle** moved out of the top-right into a small standalone button beside
  the mode cluster (no longer collides with the top status).
- **Top status** tidied: room · connection · speaking · count, with the speaking
  line truncating gracefully on narrow widths (no clipping/overlap).

**Stage & spatial + control bar** — no new scope:
- **Bigger raised stage + framed screen.** Stage is wider/deeper and raised to
  walk underneath; size/height are tunable constants in
  [zones.js](web/src/room/zones.js) (`STAGE_RADIUS`, `STAGE_TOP_Y`, …). The backdrop
  screen is larger with a visible orange-bordered frame, above/behind the stage.
- **Zones + role movement clamps.** A single source of truth ([zones.js](web/src/room/zones.js))
  defines the stage / audience / under-stage zones and a `constrainPosition()` the
  one locomotion path applies every frame: speakers can't leave the stage top,
  audience can't mount the stage or enter the green room, and a boundary ring glows
  when you hit the limit (soft edge stop, no snap-back). Phase 3's zap queue reuses
  these zones.
- **Under-stage green room + pedestal.** An enclosed walkable space beneath the
  stage, gated to the designated next-up — entered for now via `?slot=next`
  (placeholder for Phase 3's queue). A pedestal/mic spot marks the call-up point
  beside the stage front (call-up logic is Phase 3).
- **Control bar + mode cluster + top status.** One cohesive bottom bar: a
  Screen/VR/AR mode cluster (always visible; unsupported modes greyed with a
  tooltip; replaces the old Enter-VR/AR buttons), the role-aware Listen/Speak
  toggle, the listener-only Request-to-speak placeholder, a reserved ⚡ Zap slot
  (Phase 3), and the `🎙 N speaking` indicator. A minimal top bar shows room,
  voice state, a "now speaking" placeholder, and the participant count. Dark +
  Bitcoin-orange, consistent states. The mobile joystick + gyro toggle coexist
  with the bar (no overlap).

**Phase 1 lock polish** — no new scope:
- **Role-aware voice toggles.** Listener gets a **Listen** on/off toggle (audio
  playback; first "on" also satisfies the autoplay gesture); speaker gets a
  **Speak** on/off toggle (mic publish) — replacing the old Join/Mute controls. The
  `N speaking` indicator and `voice:` status badge are unchanged.
- **"Request to speak"** placeholder, listeners only — visibly disabled with a
  tooltip + a small toast on tap. No real behavior (future phase).
- **Flat-faced heads.** Every body's head is a sphere truncated by an off-centre
  flat cut (partial `SphereGeometry` via `thetaLength`, no clipping planes): a
  fuller rounded back with a flat circular face — narrower than the head — on the
  forward side, so facing is readable at a glance. The cut is a single tunable knob
  (`HEAD_CUT_DEG` in [avatars.js](web/src/room/avatars.js)). The flat face is a
  named mesh (`faceMount`) with its own material — the single mount point for the
  Nostr profile image in Prompt 2 (`faceMount.material.map = …`). The local
  first-person body stays headless so it never blocks the camera; remote viewers
  see the head.

**Bodies + token path (post-Prompt 1.1)** — no new scope:
- **Real bodies.** Your camera now has a body: a capsule (room avatar style)
  parented to the rig, so walking moves a visible figure and — as a speaker — the
  figure on the stage *is* you. Remote participants render as bodies from the
  existing presence heartbeat, now carrying yaw so they turn as well as move. The
  static on-stage prop you used to spawn inside is gone; only a few clearly-static
  audience capsules remain as ambiance, clear of every spawn point.
- **Token 404 fixed.** `VITE_TOKEN_URL` is now the **full endpoint including
  `/token`** and is fetched verbatim (no more `/token/token`). The resolved URL is
  logged once to the console for debugging.

**Foundation polish (post-Prompt 1)** — UX/robustness fixes, no new scope:
- Spawn now faces the stage on load (listener in the audience; **speaker stands on
  the stage facing the audience**) — applied to the rig in all modes.
- **Mobile controls**: a Gyro on/off toggle (drag-look ↔ device-orientation) and a
  bottom-left virtual joystick for walking, both feature-detected (touch + no fine
  pointer) so they never appear on desktop. The joystick feeds the same locomotion
  path as desktop WASD.
- **Voice never fails silently**: `VITE_TOKEN_URL` is used exactly as provided (clear
  setup error if blank); the join flow surfaces `voice error: <reason>` on the HUD,
  plus an `idle → connecting → connected → failed` status indicator. The underlying
  error is logged to the console.

---

## Seams for Prompt 2 (identity + avatars) — don't build yet

Prompt 2 adds Nostr sign-in (NIP-07 on desktop; generate/import on mobile + VR) and
the deterministic **Keyface** avatar from the npub. Where each piece plugs in:

- **Identity** → `web/src/config.js`: `identity` is currently a throwaway random
  per-tab id, and `role` is a `?role=` URL param. Replace `identity` with the npub
  and derive `role` from real gating (Lightning slot booking). The token request in
  `web/src/voice/livekit.js` (`_fetchToken`) and the server grant logic in
  `server/token.js` (`tokenHandler`) are where real role decisions belong.
- **Keyface avatars** → `web/src/room/avatars.js`: `makeCapsule()` is the only thing
  that builds an avatar's mesh. Swap it for the npub-derived Keyface; `AvatarPool`
  and `seedPlaceholders()` keep the same API, so presence / voice wiring is untouched.
- **Real presence identity** → `web/src/state/presence.js` already keys remote
  avatars by the LiveKit participant identity. Once that identity *is* the npub,
  presence is automatically tied to real people — no change beyond config.
- **Shared stage state** → `web/src/state/stageState.js` is the object later prompts
  extend (who holds the stage, stage skin, zap totals, sponsor slots) and sync over
  the same LiveKit data channel that `presence.js` already proves out.
