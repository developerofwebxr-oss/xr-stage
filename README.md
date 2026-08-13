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

**Headset bugs — sprint · X menu · exit-to-flat (4.3)** — no new deps; immersive-only fixes
headless can't catch, so each carries its diagnosis:
- **#1 VR sprint never engaged.** *Root cause:* `SPRINT_EDGE` was `0.92`, but a Quest thumbstick
  at full push reports magnitude ≈ 0.85–0.95 (the runtime radially scales it below 1.0), so the
  sprint branch was effectively unreachable — the analog walk-scaling just maxed out under the bar,
  reading as constant walk. Lowered the edge to `0.85` with a distinct `WALK_PLATEAU = 0.6`, and
  routed **both** the VR left stick and the mobile joystick through one shared `analogSpeed()` (one
  locomotion path). Desktop Shift-sprint unchanged. Full push now ≈ doubles speed; release → walk.
- **#2 X didn't open the in-world menu.** *Root cause (by elimination):* the button index
  (`buttons[4]`), handedness (`src.handedness`), press-edge (`vrEdge`), and `isPresenting` routing
  were all standard-correct — leaving **placement**. `openMenu()` anchored off the mono `camera`,
  but the X handler runs *before* `renderer.render()` writes the current head pose into that camera
  each frame, so it read a stale/rig-relative transform and spawned the panel **off your gaze** (it
  looked like "nothing happened"). Fixed by anchoring from the **live XR head camera**
  (`renderer.xr.getCamera().matrixWorld`) — position + forward — so the panel appears ~1.2 m ahead
  of where you're actually looking, at eye height. Applies to VR and Quest-AR.
- **#3 Exit to flat = tilted + displaced camera.** *Root cause:* during a session Three drives the
  mono camera's **local** transform from the live head pose — a position offset plus the full head
  orientation **including pitch and ROLL**. Flat look controls only ever write `rig.rotation.y =
  yaw` and `camera.rotation.x = pitch`; they never clear the camera's position, yaw, or roll. So on
  `sessionend` the residual head **roll returned as a tilt** and the head offset as a **position
  shift** — every exit. Added `resetFlatView()` to the **single** sessionend restore path (both the
  in-app Exit button and the platform system-quit funnel through `session 'end'` → `onModeChange
  ('flat')`): `camera.position.set(0, 1.6, 0)`, `camera.rotation.set(pitch, 0, 0)` (zero yaw+roll),
  `rig.rotation.set(0, yaw, 0)`, `updateProjectionMatrix()`. Flat's per-frame writes never re-dirty
  those, so one reset holds. View returns level, at eye height, where the rig was; drag-look
  continues smoothly. Folded #2 + #3 (and the sprint-threshold gotcha) into the `webxr-threejs`
  skill's lifecycle rules.
- **Guardrails.** One locomotion path stays unified; no service/UI changes beyond these. Clean
  build, no console errors, flat scene unregressed. The three behaviours are immersive-only —
  **owner re-tests all three on the Quest** (headless/desktop Chrome can't enter immersive).

**In-world VR/AR menu — the headset gets controls (4.2)** — no new deps; one new module
`src/room/xrMenu.js`, a RENDERER over the existing service flows (no new service logic):
- **The panel.** The **X** button (left controller, the standard Pause/Menu binding) toggles a
  3D, laser-clickable panel. It anchors **~1.2 m in front of the camera at open**, then is
  **world-locked** in position (not head-glued) and only **billboards (yaw)** to keep facing you.
  It's ONE **opaque** canvas-textured mesh (3.11 solid-panel rule — writes depth, occludes
  correctly), **re-textured only on state change** (page switch, value change, or hover change) —
  never per frame. Buttons are rectangles in canvas space; a laser hit maps its local point →
  canvas coords → the button under it, so a single mesh is the raycast target. Disposed on close.
- **Page structure (multi-page, Back button):**
  - **main** — Resume (close) · Exit to Screen (`session.end` → flat restore) · Ticket status +
    Get/Upgrade → **tickets** page · Wallet balance + Top up (mock +21,000) · Enter session code →
    **keypad** page · toggles (Boost-by-tap · Speak/Listen voice · the three comfort toggles) ·
    Zap the speaker (⚡21).
  - **tickets** — three tier buttons (Basic/Supporter/Patron) with real price + spendable credits
    + perks, current tier marked; tap → the shared **event-scoped** `buyTicket()` flow.
  - **keypad** — a 6-digit numeric pad (0-9, ⌫ del, ✓ submit — 12 big laser-friendly buttons)
    feeding the same `redeemCode()` → `adoptFlow()`. **This is THE headset sign-in path** (mint
    still happens on phone/desktop); shows "Signed in as {name}" on success. No text entry anywhere.
- **Behavior.** The in-world menu is **modal** while open (it owns the laser select; nothing behind
  it is pickable). Hover is driven per-frame by whichever controller laser is on the panel, but
  **re-textures only when the hovered button changes** (no per-frame canvas). Opening it never
  touches the DOM pause menu — in immersive the DOM is hidden, and **X routes to the in-world panel
  when `renderer.xr.isPresenting`, to the DOM pause menu in flat** (same concept, two renderers).
  **Comfort toggles are shared state** — the panel calls the same `comfort.set()` and persists as
  before. Returning to flat closes the panel. Works in **VR and AR** (Quest passthrough has the X
  button + controllers); an AR **phone** has neither, so its in-world entry is a later seam. The
  **event-transition prompt stays DOM-only** for now (a future in-world page — noted as a seam in
  `xrMenu.js`). The DOM ticket chooser and the in-world tickets page now share one `buyTicket(tier)`
  function so neither duplicates the purchase logic.
- **Guardrails.** No new service logic. Quest 72 fps safe (canvas re-texture on change only; hover
  via raycast, no per-frame canvas). Clean build, no console errors. **Verified structurally +
  emulated in Chrome**: forced the panel open in flat and screenshot all three pages (main /
  tickets / keypad) with hover highlights — layout, event-scoped prices/credits, and the keypad
  grid all render correctly; the frame loop ran `updateMenu()` every frame with no errors. The real
  headset interactions (X open, laser hover/press, keypad redeem, in-headset ticket buy, exit sync)
  are **device-tested** — headless/desktop Chrome cannot enter immersive.

**Device-pass fixes — AR + presence (4.1)** — no new deps. Five owner-verified on-device bugs:
- **#1 Stage screen now renders in AR.** *Root cause:* the main stage screen (`backdrop` +
  its `frame` + `border`) was swept into the AR **shell** hide-list, so `setShellVisible(false)`
  hid it with the enclosure. It's **diegetic stage furniture** (like the LIVE / TOP-ZAPPED
  boards), not enclosure — pulled OUT of `shell` so it shows in all four modes. Other AR
  visibility unchanged.
- **#2 Jump enabled in AR.** Dropped the `!isAR` gate in `updateJump` (and the now-dead
  `isARSession` helper) — AR gets the same modest hop as VR, off the same **A** button / Space;
  landing height still resolves via the surface-aware `constrain` callback, so a hop returns to
  the real floor.
- **#3 AR-only floor treatment.** A subtle **dark ~1.5 m disc** (radial alpha → transparent at
  its edge) follows the player's world XZ each frame, giving footing on passthrough; hidden in
  flat/VR. The orange rings read a touch stronger in AR via a new `uOpacity` uniform
  (`0.5 → 0.72`) — *more visible, not brighter* (same additive colour, no bloom). Screen + VR
  unchanged.
- **#4 Board updates are instant + event-driven.** *Root cause:* **TOP ZAPPED** (`rebuildWall`)
  was gated behind `WALL_STICKY_MS = 120 000` (a 2-min ranking hold) in both the change handler
  and a per-frame poll, so a boost never refreshed it. Now `onBoardChange` re-textures **both**
  screens immediately: LIVE on every change (while live), TOP ZAPPED whenever the ranked top-N
  changes — signature is `id:sats`, so a boost to the already-#1 card refreshes its ⚡ total the
  same frame. Removed the per-frame wall poll and the sticky const/var. LIVE was already
  event-driven; its only residual delay is the upstream mock wallet settle (~1 s), not the render.
- **#5 Body follows the head in VR/AR.** Physically stepping moves the head within the rig; each
  frame `followBody()` pins the local body's XZ + yaw under the head (WebXR writes the head pose
  into `camera` as a rig-LOCAL offset — the same space the body child lives in). Presence now
  broadcasts the **head's world pose** (XZ + yaw; y stays at floor level) so peers see us where
  our head is. Thumbstick locomotion still moves the rig. **Zone-edge behavior:** clamp/detection
  stay on the **rig** (the clampable thing — a walking user can't be physically stopped); step
  past a boundary and the rig clamps + the edge glows, but the head — and thus the body and what
  peers see — may briefly **overshoot** the line until you step back. Flat mode keeps the body at
  the rig origin.
- **Guardrails:** re-textures stay event-driven (no per-frame canvas work added); follow/pose math
  is a few vector ops per frame (Quest 72 fps safe); modes/services/menus untouched beyond the
  above. Clean build, no console errors. *Flat path verified in Chrome (scene renders, screen
  visible, no errors); the AR/VR immersive paths — #1, #2, #3, #5 — can't be entered by headless/
  desktop Chrome and are owner-tested on device.*

**Event-scoped economics — the marketplace model (3.18)** — no new deps:
- The venue is now a **marketplace of events**. Every booking creates an **event**
  `{ id, title, ownerPubkey, startsAt, endsAt, speakers[], slotIds[] }`; consecutive slots (≤ 3)
  book as **one event** (booking UI gained a 10/20/30-min length picker). `booking` gained
  `events()` · `currentEvent()` · `nextEvent()` · a **mock clock** (`now()` + a flagged dev
  `__skip(min)`), and a few seeded events so the schedule + transitions have content.
- **Tickets are per-event.** Buying a tier buys it for the running (else next) event; the pass
  stores `eventId`. The speaker share goes to **that event's `speakerPot`** (the global pool is
  dropped — mock data). `tickets`: `buy(tier, eventId)`, `speakerPot(eventId)`, `grantSpeakerPass
  (eventId)`, `heldEventId()`/`holdsFor(id)`, `lapseToGhost()` (keeps identity + credits +
  badge-history).
- **Pass lifetime + transitions.** A pass is valid through its event + **`INTER_EVENT_GRACE_MIN =
  10`** (stay embodied through dead air). A small **transition engine** watches event boundaries:
  at grace expiry it **lapses to ghost**; when a new/different event starts it shows the
  **transition prompt** once (to embodied non-holders + signed-in ghosts) — *Get a ticket* (tier
  chooser scoped to the event) · **⚡ Welcome zap 210** to the speaker (everyone, no status
  change) · *Continue as ghost* (dismiss → lapse; credits kept, credits never expire).
- **Ghost zapping un-gated.** Zap/boost paths → `requireSignedIn` (+ balance), not `requireTicket`
  — signed-in ghosts top up and zap (speaker, boosts) with no ticket. Post/comment/queue/zones/
  embodiment stay gated.
- **UI:** the tier chooser header names the event; the Stage **Schedule shows events** (time ·
  ● live · title — organizer); pot lines → **"⚡ This event's speaker pot: N"** (Stage + Speaker
  hub); the You menu shows **"Ticket: {event} · until {end}+grace"**. Venue economics unchanged
  (flat 10% fee, 100% slot rent); per-event custom pricing is a seam only.
- **Verified** in Chrome with the dev time-skip: buy into A → embodied, **A's pot = the share**;
  skip past A's end → **grace-embodied**; B starts → **prompt shows**; decline → **ghost, credits
  kept, zone access dropped**; **ghost welcome-zaps** B's speaker (balance drops); buy into B →
  embodied, **B's pot funded, A's pot untouched**; Schedule lists events with ● live; chooser
  header scoped to the event. No console errors.

**Zone polish — trees, interiors, occupancy (3.17)** — no new deps:
- **BUG fixed — trees no longer inside the zones.** The instanced scatter now rejects any
  candidate inside a zone's **detection circle**, the **building footprints** (+ margin), the
  **door-approach corridors**, or the **central plaza walkway** — so trees only ever sit
  OUTSIDE, as backdrop + side screening. Verified programmatically: **0 of 156 trees** land in
  either detection circle or footprint. Deterministic as before.
- **Better trees.** Plain cones → a stylized **3-tier conifer** (slightly-irregular stacked
  cone tiers merged into one geometry + a short trunk), with per-instance scale/height/rotation/
  **tint** variation (cool-dark generally, **ember rim near Smoking**). Two `InstancedMesh`es
  (trunks + canopies), shared materials, no lights/shadows — "forest at night," not toy cones.
- **Networking — much deeper + grander.** `INTERIOR_DEPTH` 9 → **22** (~2.4×), width via
  `wallHalf` 0.22 → **0.30** (interior ~18.8 m wide), ceiling 5.4 → **7.0 m**. The detection
  bound follows the new hall (near edge ≈ the doorway), `zoneAnchors` prop-spawns respawned
  across the bigger room (6 spots), enclosure re-verified from the plaza + a side orbit (no
  sightline leaks). The occupancy-scaling seam on `INTERIOR_DEPTH` is kept.
- **Occupancy display.** `zones.occupancy(id)` → `{ count, patron, supporter, speaker }` from a
  **deterministic seeded population** + the **local player when inside** (`setLocalBadge`). The
  **HUD zone pill** now reads live, e.g. `🤝 Networking · 12 inside (◆4 ◇4 🎙2)`; each
  **entrance plaque** carries a `👥 N inside · ◆x ◇y 🎙z` line (social proof before entering),
  re-textured **on change only**. Real presence-driven counts are a noted seam (presence will
  broadcast zone id with its heartbeat).
- **Roadmap seams (not built):** `zoneAnchors.walls` / the Smoking hedge are the future
  **sponsor-screen** mounts (kept clear); a future paid **Ostrich Farm** reuses the zone/gate/
  access system — both just noted in code.
- **Verified** in Chrome (manual renders): tree-free interiors, the new conifer forest, the deep
  Networking hall (looked through the doorway), and the pill + plaque occupancy with badge
  mixes. No console errors. (Owner device-tests interior scale in VR.)

**HUD pill collision — one stacking system (3.16)** — presentation/layout only:
- The top-centre transient hints + status pills (controls hint, Free-look ESC hint, ghost/
  invisible pill, zone locality pill) each had their own absolute anchor and **overlapped** when
  shown together. Replaced the scattered absolutes with **one top-centre flex-column stack**
  (`#pill-stack`) sitting just below the status bar; every pill is a normal flow child sharing a
  `.hud-pill` base, so hidden pills take no space and the column **reflows** as they appear/
  disappear — never overlapping, always a consistent 8px gap.
- **Stack order (top→bottom):** status bar → **transient hints** (controls · ESC) → **persistent
  status pills** (ghost · zone). The zone locality pill **moved from bottom-centre into this top
  stack**. Two persistent pills (invisible + zone) **STACK, not merge** — chosen for clarity so
  each keeps its own hue/meaning; merging two-into-one read as noisier.
- Respects `env(safe-area-inset-top)` (below the notch/status bar), caps width to
  `100vw − 24px`, and the long controls hint **wraps** rather than overflowing — so nothing
  collides with the status bar, the notch, or the screen edges on any width. Each pill keeps its
  exact show/hide logic + timing + accent; **only the positioning changed** (no JS/behaviour/
  service changes).
- **Verified** in Chrome by forcing combinations (ghost + controls hint; ghost + ESC hint;
  invisible + zone; **all four at phone width**): no overlaps anywhere, 8px spacing throughout,
  the long hint wraps and everything stays within the viewport. No console errors.

**Speaker path — slot = your ticket (3.15)** — no new deps:
- **Booking IS the speaker's ticket** — no attendee tier required. Book-a-slot now gates on
  **`requireSignedIn`** (not `requireTicket`): a ghost who signs in can book. All other
  spend/post/queue gates are unchanged, and a **speaker counts as a member** there too (a
  speaker with 0 credits tops up like anyone to zap).
- **Slot price** from named config **`SLOT_PRICE_PER_10MIN = 10000`** (linear with duration;
  10-min slots at 10,000). The slot fee is a **mock external entry payment** (not from local
  credits — same custody-free pattern) and goes **100% to the venue** as stage rent —
  `tickets.recordVenue()` / `venueRevenue()`, **never** the speaker pool (pool stays
  attendee-funded).
- **Speaker pass** (`tickets.speakerPass()` / `grantSpeakerPass()`) — a **parallel pass**, not a
  tier: on a confirmed booking it grants **embodiment** (a ghost gets a body), a distinct
  **🎙 Speaker badge**, **networking + smoking** access, and a **backstage** seam flag (no zone
  yet). It **coexists** with any attendee tier (a Patron who books keeps both perk sets),
  persists per pubkey, and is **kept on cancel** (policy const `KEEP_PASS_ON_CANCEL` — simple +
  generous; no refund either way). Embodiment logic now keys off *member* (paid tier **or**
  speaker pass), so `tickets.visible()` folds the pass in.
- **UI:** the booking surface shows the price + **"Booking includes your 🎙 Speaker pass — no
  ticket needed."** The **tier chooser stays attendee-only** (no speaker card). The **You menu**
  and **Speaker hub** reflect the pass (status/🎙). **Badges:** the 🎙 mark is a distinct orange
  mic baked into the label canvas, **combinable** with the tier gem (gem then mic).
- **Verified** in Chrome: a signed-in ghost books a 10-min slot for **10,000** → **embodied +
  🎙 + networking/smoking access, no credits added, pool unchanged, venue +10,000**; cancel
  **keeps** the pass; a Patron who books keeps **both** (◆ + 🎙); the tier chooser is unchanged
  (Basic/Supporter/Patron). No console errors.

**Ticket economics v2 — flat venue fee + progressive speaker pool (3.14)** — no new deps:
- **New split, same custody-free flow.** Every tier: **flat 10% venue fee**, a **progressive
  speaker share (10 / 20 / 30%)**, and **credits = the remainder**. Prices keep the 21-motif:

  | Tier | Price | Venue (10%) | Speakers | Credits |
  |---|---|---|---|---|
  | Basic | 2,100 | 210 | 210 (10%) | **1,680** |
  | Supporter | 10,000 | 1,000 | 2,000 (20%) | **7,000** |
  | Patron | 21,000 | 2,100 | 6,300 (30%) | **12,600** |

  `VENUE_FEE` + `SPEAKER_SHARE` are named config; `tickets.split(tier)` derives the exact
  `{ price, venue, speakers, credits }` (remainder = price − shares, always reconciles). `buy()`
  is unchanged in flow — mock external entry payment → credits the wallet the post-split amount —
  and now stores the split on the purchase record.
- **Speaker pool accumulator:** `tickets.speakerPool()` — one **venue-global** pot (persisted)
  that grows by each ticket's speaker share; `onChange` fires on growth. **Distribution is a
  deliberate SEAM** (code note): at go-real the pot is split **among booked slot-holders by stage
  time** (booking knows the slots) and paid over Lightning — NOT built here; `booking` untouched.
- **The pool is public (it's marketing):** shown as **"⚡ Speaker pool: N sats"** on the **Stage
  Schedule panel** (updates live on growth) and as **"⚡ Pool (all speakers): N sats · split by
  stage time at payout"** in the **Speaker hub** (per-speaker share is a noted seam, not computed).
- **Tier cards** now show the full transparent split — e.g. Patron `→ 12,600 credits · ⚡2,100
  venue · ⚡6,300 to speakers` — and frame the speaker share positively as a perk line
  (Basic "10% supports the speakers" … Patron "30% to the speakers — patron of the event").
- **You menu**, after purchase: a small **"where your sats went"** line under the tier status —
  `venue 2,100 · speakers 6,300 · credits 12,600`.
- **Migration:** old persisted purchases (pre-3.14, no split) load fine — `lastSplit` defaults to
  null and the split line simply isn't drawn. No re-crediting.
- **Verified** in Chrome: each tier credits the exact table amounts (only the credits, not from
  local balance); the pool accrues exactly the speaker share per purchase (fresh pool 0 → Patron
  → 6,300) and shows on Schedule + You menu + Speaker hub; old records render safely. No console
  errors.

**Ticketing + embodiment — ghost mode & tiers (3.10)** — no new deps; the business model:
- **Free = ghost, paid = embodiment.** A signed-out/un-ticketed visitor is a **ghost**: listens
  + moves, but has **no body/name-label**, doesn't broadcast presence (peers render nothing for
  them), and **can't post/zap/queue/book or enter paid zones**. A one-time **ticket** per identity
  buys embodiment + venue **credits** + perks.
- **`tickets` service** (`src/tickets/tickets.js`, persisted per pubkey like the wallet):
  `tier()` · `buy(tier)` · `flags()` · `visible()/setVisible()` · `purchaseAccess(kind)` ·
  `onChange()`. **Money flow (mock, custody-free):** `buy()` is the **entry payment** (mock
  "external", not from local credits) → on confirm it sets the tier **and** credits the wallet
  the **post-fee** amount. Tiers: **Basic** 2,100 sats → 1,890 credits · **Supporter** 8,000 →
  7,200 (+ badge, networking priority, networking/smoking access) · **Patron** 21,000 → 18,900
  (+ distinct badge, all Supporter flags, front-row + sponsor-spot flags). The **10% venue fee is
  shown at purchase**. Micro-purchases (`purchaseAccess`) spend **credits → venue** for a door
  flag (`wallet.spend()`); only `networking`/`smoking`/`frontRow` are recognised.
- **Ghost mode:** `getPose()` returns null while ghost/invisible → presence skips the heartbeat
  (peers never render a body). Status bar now shows **both counts** — `👥 N · M listening`
  (embodied bodies · ghost listeners, seeded plausibly). Local body hidden; a subtle
  "👻 observing as a ghost / invisible" pill shows.
- **Gate:** the central `requireSignedIn` grew a `requireTicket` — every spend/post/queue/book
  path now needs a paid ticket (signed-in ghost → prompts the tier chooser; signed-out → sign-in).
- **Buy UX** (`src/ui/ticketUI.js`): a "🎟 Get a ticket" entry in the You menu (primary while a
  signed-in ghost) + the tier chooser (prices, credits, fee, perks — Live Console). On confirm:
  body appears, credits land, **badge** shows on the label (Supporter/Patron distinct, baked into
  the label canvas — no new mesh), toast confirms. Paid users get a **Go invisible / Go visible**
  toggle (persisted per pubkey).
- **Zone gates:** the `zones` seam is wired to the flags — entering Networking/Smoking without the
  flag **softly bounces** you to just outside the boundary (`accessClamp`, no hard teleport) and
  prompts: ghosts → the ticket chooser; Basic → the **credits access purchase** (500 credits each);
  Supporter/Patron walk straight in. The HUD zone pill only fires when legitimately inside.
  Front-row / sponsor stay **flag-only** (no zone/screen yet). *Audio isolation on enter/leave is
  the later audio-zone slice — a code note marks the seam; voice/LiveKit untouched here.*
- **Verified** in Chrome: fresh identity = ghost (listens, `3 · 33 listening`, invisible to
  presence, gated actions prompt a ticket); buy Basic → embodied + 1,890 credits + `4 · 32` +
  bounced at both doors → buys Networking access (credits) → walks in; Supporter/Patron → badges +
  flags + both doors open (front-row flag seam-only); go-invisible round-trips the counts; all
  persisted per pubkey across reload; the 10% fee is shown at purchase. No console errors. (Voice
  connect + the VR/AR feel are the owner's device pass.)

**Enclose the zones + decoration seams (3.13c)** — no new deps, no services touched:
- Made both zones **enclosed, exclusive interiors** — not visible into from the plaza, ready
  for future textures/props. The `zones` seam + all existing behavior are unchanged.
- **Networking = full enclosure:** the curved facade now closes into a real room — **side
  walls + back wall + a ceiling** joined to it (clean, flat, dark **texture-ready** planes,
  generously sized, no decorative geometry). From the plaza you see only the facade + a **dark
  doorway**; orbiting the sides shows a solid dark box; inside, the plaza is only visible back
  through the doorway. Interior height 5.4 m; depth keeps the 3.13b `INTERIOR_DEPTH = 9`
  parameter (occupancy-scaling seam still noted, still static).
- **Smoking = enclosed clearing:** behind the gate, a distinct **texture-ready ground** walled
  by a **closed hedge perimeter** (back + sides + two gate-flanking fronts) so the **gate is
  the only opening**; a denser tree screen wraps it and the treeline recedes to the horizon as
  backdrop (fog fades it). Open-air (no roof) — night sky above the hedges, as a park.
- **Decoration registry** (`zoneAnchors`, exported from the zones module) — named refs so a
  later slice / the owner's generated textures + GLB props attach without hunting the scene
  graph:
  - `zoneAnchors.networking = { walls:[back,left,right], floor, ceiling, propSpawns:[…] }`
  - `zoneAnchors.smoking    = { ground, perimeter:[back,left,right,frontL,frontR], propSpawns:[…] }`
  - `propSpawns` are empty `Object3D` transforms parked at interior spots (world-correct via
    their parent), named — e.g. `net-centre`, `net-sofa-L/R`, `net-back`; `smk-cigar-bar`,
    `smk-bench-L/R`, `smk-heater`. Verified present at the right world positions.
- **Audio-exclusivity SEAM (note only, no behavior):** a clear code comment on the zones seam
  states that `onChange` enter/leave will drive audio **isolation** later (zone occupants hear
  each other, the plaza doesn't hear them, and vice versa) in the audio-zone slice. Nothing
  here touches voice/LiveKit.
- **Plaque copy edit:** Smoking Area loses the cigarette line → "Permissionless talk. The
  closer you stand, the better you hear. Entry: ticket + mic permission — your mic is ON in
  here." (The cigarette is an entry surprise, not signage.)
- **Perf:** enclosure = ~30 large flat static meshes + **1** instanced tree mesh across both
  zones; shared materials, emissive accents only, no lights/shadows/per-frame work; interiors
  dark until decorated. AR: still freestanding diegetic props.
- **Verified** in Chrome (orbited the plaza with manual renders): interiors are **not visible
  from outside** — Networking is a closed dark box with a dark doorway; the Smoking clearing is
  screened by hedges + trees with the gate the only opening. The enter/leave seam still fires
  (inside hall → teal pill, past the gate → ember pill). No console errors. (Owner device-tests
  enclosure feel + doorway scale in VR.)

**Zone buildings — push-back + facades (3.13b)** — no new deps, no services touched:
- The 3.13 zones read as floor decals right next to the crowd. Reworked into **distant
  destination buildings across a plaza** — a real courtyard walk — with real entrances.
  Facades + shells only (interiors are a later slice). The `zones` seam API is unchanged;
  only the bounds moved/reshaped.
- **Pushed way back** (~3× the old distance — ~18 m from the audience spawn, vs ~5–8 m):
  - **🚬 Smoking Area** — park gate, front-centre `(−13, 19)`, back-**left**.
  - **🤝 Networking** — hall doorway, front-centre `(6, 24)`, back centre/right.
  - The facades are **arcs concentric with the stage** (centre `(0,−7)`, same as the radiating
    floor rings): Networking wall radius **≈ 31.6 m**, Smoking gate radius **≈ 29.1 m**.
  - **Clamp** `AUDIENCE_RADIUS` **24 → 38 m** (the ONE clamp source in `room/zones.js`); the
    floor disc + grid now derive from it (`AUDIENCE_RADIUS + 10`) and the rings reach `+3`, so
    the plaza covers the whole walk with dark void beyond.
- **Networking = curved hall:** a tall dark curved front wall (two open-ended cylinder-arc
  segments) with a **doorway gap** in the middle (walk-through, teal jamb glow + lintel trim),
  and a **deep shell** behind it — dark floor + back wall + two receding teal edge-lines fading
  into the dark (fog does the fade). **Shell length is a parameter** (`INTERIOR_DEPTH = 9`) —
  seam noted in code: occupancy will scale it later (10 vs 300 people); NOT dynamic now. Teal.
- **Smoking = park entrance:** a **gate** (two posts + ember cap + arch beam/sign frame, name
  over the arch) and a **receding treeline** — one `InstancedMesh` of ~35 cone silhouettes
  (dark ember, deterministic placement) fanning back and fading into fog. Interior left empty
  (later slice). Ember.
- **Bounds** are now "inside the building / past the gate": detection circles sit just past
  each entrance — Networking `(6.48, 26.46) r 3.4`, Smoking `(−14.1, 21.2) r 3.2` — so the HUD
  pill fires on actually entering. **Plaques** moved to stand beside each entrance (same copy).
- **Perf:** ~20 static meshes + 1 instanced tree mesh across both zones; shared materials,
  emissive-via-MeshBasic, no lights/shadows/per-frame work. AR: buildings/gate/trees are
  freestanding diegetic props (no room shell involved) → visible in AR.
- **Verified** in Chrome: the enter/leave seam still fires at the new bounds (inside Networking
  → teal pill, past the Smoking gate → ember pill, plaza/spawn → hidden); the curved facade +
  walk-through doorway + receding dark shell, the gate + fog-fading treeline, big wayfinding
  letters, and the beside-entrance plaques all render correctly. No console errors. (Owner
  device-tests scale/walk feel — building height + letter size at head height in VR.)

**Zone shells — Smoking Area + Networking (3.13)** — no new deps, no services touched:
- Two social zones behind the audience as visible, named PLACES, plus the detection **seam**
  the ticketing/audio slices will consume. No entry gating, no mic/audio, no props-on-people
  yet (those need the ticketing slice) — this is world-building + the enter/leave events.
- **Placement** (standing on the audience floor FACING the stage → stage is −Z, so "behind"
  is +Z, "left" is −X). Circles, metres, world space:
  - **🚬 Smoking Area** — back-LEFT, centre `(−7.5, 9)`, **r = 3** (ember `#ff6a2c`).
  - **🤝 Networking** — back centre/right ("opposite the stage"), centre `(3, 11.5)`, **r =
    4.5** — noticeably larger (~2.25× the area) (teal `#27c6c6`).
  - Both sit well clear of the stage/boards. The audience clamp (`AUDIENCE_RADIUS`, the ONE
    clamp source in `room/zones.js`) went **20 → 24 m** so the back zones are comfortably
    reachable; the floor rings derive from the same constant.
- **Signage:** large glowing 3D name letters (canvas-texture planes, emissive-via-MeshBasic
  for bloom, no per-frame redraw) standing over each zone, facing the audience (Networking
  larger). **Floor treatment:** a translucent hue disc + a brighter edge-glow ring marking
  each bound. **Plaques:** a short stand at each entrance edge holding a SOLID canvas panel
  (opaque backdrop per the 3.11 rules) with the zone copy, readable up close.
- **Seam** (`zones/zones.js`, distinct from `room/zones.js` which owns layout/clamp):
  `zones.current()` · `zones.onChange(cb)` · `zones.update(x, z)` — cheap squared-distance
  circle checks, self-gated so it only works when the rig moves and only emits on an actual
  enter/leave. The frame loop polls it; the sole consumer for now is a HUD **locality
  indicator** — a small "🚬 Smoking Area" / "🤝 Networking" pill (in the zone's hue) shown
  only while inside, nothing more (no gating, no "coming soon").
- **AR:** zones are floor markings + freestanding props (letters/plaques) added straight to
  the scene, NOT part of the room shell AR hides → they stay visible (diegetic). Quest-friendly:
  emissive over lights, no shadow maps, no per-frame canvas.
- **Verified** in Chrome: the enter/leave seam fires and the HUD indicator toggles — enter
  Networking → "🤝 Networking" (teal), enter Smoking → "🚬 Smoking Area" (ember), leaving
  hides it; moving within a zone does not re-emit. Signage + plaques + floor tints render with
  correct placement/hues and un-mirrored letters. No console errors. (Owner device-tests the
  walk + look; the immersive VR/AR path can't be entered from desktop Chrome.)

**Headset session code — log in your identity on VR/AR (3.9)** — one small backend
addition, no new deps, no new env:
- **Cross-device pairing pointed at LOGIN.** A signed-in phone/desktop mints a **6-digit,
  one-time, ~5-min code** bound to its **public** identity profile; the headset (or any
  device) redeems it and **adopts** that identity, so it can zap/post/queue **as that
  person** in VR/AR. Balance follows via the existing per-pubkey wallet persistence.
- **Server (`server/session.js`, beside `/token`):** `POST /session-code` → `{ code,
  expiresAt }`; `POST /session-redeem` → the public profile (or `400/404/410/429`).
  In-memory store (no DB). **No secrets ever accepted or stored** — public display fields
  only, unknown fields dropped, no nsec touches the server (real signing stays on the origin
  device; the headset session is a reader/spender of the venue balance). Codes are single-use
  (deleted on first redeem), TTL-purged, and redeem is **rate-limited 10/min per IP**
  (`trust proxy` for the real client IP). CORS reuses the existing `ALLOWED_ORIGIN`.
- **Client:** server base is **derived from `VITE_TOKEN_URL`** (strip `/token`) — no new env.
  - **Mint (You → “📟 Log in on headset”, signed-in):** big monospace code + live countdown
    (“expires in 4:59”) + Regenerate + hint.
  - **Redeem (You → “📟 Enter code”, on the sign-in surface):** 6-digit input → adopts the
    identity (same shape as sign-in; `identity.adopt(profile)` — additive, interfaces
    unchanged). Errors surface cleanly (“Code invalid or expired” / “Too many attempts”).
  - **VR/AR v1:** the DOM sign-in is invisible in immersive mode, so redeem in **flat mode
    first, then enter VR** (stated in the redeem hint). **SEAM noted in code:** the natural
    first in-world-UI piece is a 6-digit VR keypad on the sign-in surface (far simpler than a
    text keyboard), feeding the same `redeemCode()`/`adoptFlow()` path — not built here.
- **Verified** (two origins = two separate localStorage stores = phone + headset): mint on
  A (*Nova Willow*) → redeem on B → **B adopts Nova Willow**; second redeem of the same code →
  “Code invalid or expired”; expired code → 410; bad/short codes → 400; **rate limit** → 429
  after 10/min; the injected `secret` field was **dropped** by the server. Adopted identity
  spends/persists under the correct pubkey (top-up on B saved 21 000 sats under her key). No
  console errors. **Known mock limitation:** balance lives in per-browser localStorage, so it
  does not literally sync across devices yet — resolved when the wallet goes server-side; the
  identity adoption is the feature here. **Railway:** same service, two new routes, no new env
  — deploy is a push (`ALLOWED_ORIGIN` already set).

**Scroll feel + in-world scrollbar (3.12c)** — no new deps, no services touched:
- **Retuned scroll to read like reading, not paging.** All input (wheel · drag · thumb · VR
  stick) now funnels through a single **target** offset; the rendered offset **eases** toward it
  (`SCROLL_SMOOTH_HZ = 16` → ~0.25 s settle), gliding through **every** intermediate comment
  (each rendered a frame or two, readable) instead of snapping multiple rows. `prefers-reduced-
  motion` → instant steps, no easing.
  - **Wheel:** `deltaMode` normalized (lines ×`WHEEL_LINE_PX = 33`, pages × panel px), deltas
    **accumulated** per `WHEEL_STEP_PX = 100` (≈ one classic notch), and **clamped to ≤ 1 comment
    per event** — so one notch = one comment and a trackpad's flood of large/inertial deltas can't
    blow through the whole history. (Verified: 1 notch → 1; a single `deltaY 5000` → 1; 200 px of
    tiny trackpad deltas → 2.)
  - **Drag:** `STEP_PX = 64` px of finger/mouse travel per comment (≈ a card's on-screen height →
    ~1:1). The old per-move delta was already once-per-gesture, but the target+ease model kills any
    residual multi-row jump.
  - **VR:** right-stick-Y routes through the same eased target (`VR_SCROLL_RATE = 5` comments/s at
    full deflection). Device feel is owner-tested.
- **Slim in-world scrollbar** down the LIVE panel's right edge (Live-Console: dark track, subtle
  orange thumb — one quad, Y-scaled + repositioned on change, **no per-frame canvas**):
  - Thumb height ∝ window/history (`FEED_N / count`, floored at `SB_MIN_THUMB = 0.4 m` so it stays
    grabbable); position ∝ offset. **Bottom = live**; hidden when history ≤ the window.
  - **Draggable** (mouse · touch · VR aim+grip): grab the thumb (or the track) and slide — maps the
    ray's panel-Y to an offset **1:1** and jumps there directly (thumb tracks the finger). Dragging
    the thumb **never boosts** (it's classified above cards in the raycast).
  - **Track-tap** above / below the thumb **pages** one window toward older / newer.
  - Raycast priority (targets can sort out of visual order at grazing angles): **thumb > "● live"
    chip > track > card > backdrop.** The chip + ~10 s idle snap-back are unchanged (thumb → bottom
    = live). Tap-boost + the boost-by-tap toggle rules are intact.
- Verified in Chrome with real event dispatch + deterministic frame-stepping (a background tab
  throttles rAF): wheel step/clamp/normalize; easing curve visits every integer window; thumb size
  + position + movement; scrub maps top→oldest, bottom→live, mid→mid; track-tap pages; a real touch
  hold-drag scrolls end-to-end. No console errors; no debug handles shipped. VR grip-scrub is
  on-device.

**Scroll polish + toggle-switch UI (3.12b)** — no new deps, no services touched:
- **"Boost posts by tap" is now a real pill switch** (Live-Console style — orange when ON, gray
  when OFF, knob slides) instead of reading as plain text. Same behavior/persistence as 3.12; the
  switch reflects state via `aria-checked` (kept separate from the `.ctl.on` full-orange button
  style to avoid the whole row going orange).
- **Root cause of "board scrolling doesn't work on desktop":** the default seed held exactly
  `FEED_N` (6) comments, so `maxOffset = count − FEED_N = 0` — there was **nothing older to scroll
  to** and both the wheel and the hold-drag silently no-op'd. The *handlers were correct all along.*
  Fix: **seed scroll headroom** (13 seeded comments > the 6-row window) so the LIVE feed is
  scrollable out of the box. (A second gotcha for testers: the drag direction is *drag-down → older*;
  dragging up at the live edge is a no-op by design. Wheel-up → older.)
- **Every mode re-verified with real event dispatch** (not just synthetic asserts): desktop
  **wheel** pauses; a **touch-type PointerEvent** hold-drag (the mobile path) pauses — Pointer
  Events unify mouse + touch so no separate touch handlers are needed, and the canvas keeps
  `touch-action: none`; the **"● live" chip** renders when paused; the toggle flips ON↔OFF and
  persists. VR (right-stick-Y) and phone-AR touch reuse the same `scrollFeed`/handlers — on-device
  owner tests. No console errors; no debug handles shipped.

**Boost-by-tap toggle + per-user LIVE scrolling (3.12)** — no new deps:
- **"Boost posts by tap" toggle** (accidental-zap protection) in the spend hub — default
  **ON**, **persisted per pubkey** when signed in (else a device default). OFF → aiming/
  tapping a comment card is **inert** (no zap, no error) across desktop click · mobile tap ·
  VR select. Applies only to board-comment boosting; avatar zaps unchanged.
- **Per-user LIVE-board scrolling** — the scroll offset is **client-local** (never broadcast,
  never in the board; two tabs scroll independently, signed-out ghosts can scroll too). The
  board stays the single shared source; `board.recent(n, offset)` just exposes older windows.
  - **Flat/mobile:** mouse-wheel over the LIVE panel, or a vertical hold-drag on it (a pointer
    that *starts* on the panel is owned by the scroll handler — capture phase — so it scrolls
    instead of rotating the camera). **Drag threshold 8px** disambiguates scroll from tap: a
    clean tap = boost (toggle-gated); a drag = scroll (never boosts).
  - **VR (chosen input): aim the right controller at the LIVE panel + push the right stick
    UP/DOWN (axis Y) to scroll.** Turn is the stick's X axis, so it's unaffected — no
    suppression needed, and right-stick-Y is otherwise unused. (Grip-drag was the alternative;
    this is lighter and reuses a free axis. Device-only.)
  - Scrolling back **pauses** the auto-scroll and shows older comments + a **"● live" chip**;
    tapping the chip or ~**10s** idle snaps back to live. New comments keep arriving in the data.
    Re-textures on scroll-step only (no per-frame canvas work). TOP ZAPPED / MIC QUEUE unchanged.
- Fixed a real hit-testing bug found while verifying: the "● live" chip could sort *behind*
  cards at grazing angles, so the scroll handler now scans all ray hits and lets the chip win
  when the ray passes through it (else tapping it would have boosted a card).
- Verified flat in Chrome: toggle default ON / OFF inert / persists; windowed `recent(n,offset)`;
  wheel-over-panel pauses (off-panel ignored); drag scrolls without boosting; clean tap boosts
  (+21) and stays paused; scrolled window shows older; snap + clamps; chip appears when paused
  and chip-tap snaps to live; signed-out can scroll but can't boost; board holds no scroll state.
  No console errors. VR scroll + scroll *feel* are on-device (owner tests).

**Queue alignment + solid panels + boost fling (3.11)** — panels/effects only, no services touched:
- **MIC QUEUE aligned with TOP ZAPPED.** The queue table now shares the boards' vertical
  extent (same bottom + top edge, height 3.6, centre y2.7, z-6.2) on the far left,
  **slightly narrower** (3.0 vs 4.0 — it's a table, not a feed); typography scaled up for
  the taller canvas. Violet style unchanged; re-texture on change only.
- **Panels are SOLID.** All panel backdrops are now **opaque** (`transparent:false`,
  `depthWrite:true`) — the depth buffer handles cross-panel occlusion at any angle, fixing
  the bleed where one panel's cards showed through another's backdrop. The 3.7 within-panel
  `renderOrder` layering (backdrop → frame → cards → title) is kept and still valid (the
  opaque backdrop draws first and writes depth), so **row visibility stays view-angle-
  independent** (no 3.7 regression). The main screen was already opaque (MeshStandard) — no
  change. The queue panel is a single opaque mesh.
- **Comment-boost fling.** Boosting a comment now flings a **⚡+amount off that card**: it
  originates at the card (raycast hit point), slides out toward the panel's near side (left
  panel → left, right → right), arcs upward and fades above the screen top (~1.1–1.5s, per-
  burst randomness). Spamming boosts reads as an **upward rain**; each burst is one Sprite,
  spawned on the event and disposed on fade, **capped at 20** (oldest culled) — no per-frame
  canvas work. `prefers-reduced-motion` → a brief static fade at the card. **Avatar zaps
  unchanged** (burst at the person).
- Verified in Chrome: backdrops opaque + queue aligned (3.0×3.6, y2.7/z-6.2) via scene-graph
  inspection; siblings render bottoms/tops aligned, violet vs orange, no bleed at overlap;
  fling spawns at the card, slides outward + rises + disposes, cap holds at 20; no console
  errors. Full orbit/pitch + on-device recheck is the owner's.

**Queue table style + sign-in gating + typing fix (3.8)** — no new deps:
- **MIC QUEUE → violet table.** The in-world queue panel is now a single-canvas TABLE
  (rank · keyface · name · ⚡total, pitch on the top entry) framed in **Nostr-violet**
  (the reserved identity colour) — violet frame + row separators + title/accents —
  visually distinct from the orange comment boards. "— empty —" state kept; re-textured
  on change only.
- **Sign-in gating + local per-identity wallet.** The wallet is now a **local venue
  balance tied to your identity**, not an external connection. "Connect wallet" → **"Top
  up wallet"** (⚡, mock +21,000; the seam stays for a real invoice top-up later). Balance
  is **persisted per pubkey** in `localStorage` and spends persist as they happen — log out
  and back in with the same identity → same balance; a different identity → its own (0).
  Signed **out**: the You menu shows **no balance**, Sign in is the primary button, Top up +
  Activity are dimmed (toast "Sign in first"). Signed **in**: balance + active Top up +
  live Activity. Every spend/post (zap, Zap-the-speaker, comment, boost, Take the mic,
  Book a slot) is **sign-in-gated**; insufficient balance reuses the failure path to prompt
  Top up. Logout clears the in-memory balance (reloads from the pubkey's store on next
  sign-in).
- **Typing fix.** Game/locomotion keys are now suppressed while any editable element has
  focus (central guard in the shared keydown handler: `input`/`textarea`/`contenteditable`)
  — Space types a space instead of jumping; WASD/E/F/M/Esc-menu no longer hijack fields.
  `keyup` isn't guarded, so keys pressed before focus still clear. (Folded into the
  webxr-threejs skill.)
- Verified flat in Chrome: violet table with 2 entrants (distinct from the orange boards);
  signed-out gating (no balance, spends blocked, prompted sign-in); guest sign-in → top up →
  zap; logout + re-sign-in restores the balance; a second identity has its own; typing
  "hi everybody gm" with spaces in the compose field (no jump). No console errors.

**Board visibility bug + mic-queue reposition (3.7)** — presentation only, no service/data changes:
- **Fix: comment-screen rows appeared/vanished with camera pitch.** Root cause was a
  transparent draw-order flip: the near-opaque screen backdrop (`transparent`, 0.92) and
  the card planes were all in the transparent pass with equal `renderOrder`, so the
  renderer ordered them by camera distance — as you pitched, top-vs-bottom rows sorted
  before/after the backdrop and the backdrop painted over whichever sorted first, so rows
  dropped looking up/down. Fixed by pinning `renderOrder` (backdrop 0 · frame 1 · cards 2 ·
  title 3) and setting the backdrop `depthWrite:false`, so the stack paints deterministically
  regardless of view angle. No camera-dependent row visibility remains (the LIVE feed's
  edge fade is scroll-based, not view-based). Avatars stay opaque and still occlude cards.
- **Move: MIC QUEUE panel → far left.** It sat centre-right, blocking the main screen /
  speaker; now on the far-left board wall (x≈-10.3, outboard of TOP ZAPPED at x-7, matching
  the inward yaw), so the centre is unobstructed from the audience floor. The pedestal
  "you're up" ring stays at the pedestal (location-bound).
- Re-texture-on-change unchanged (no per-frame canvas work); 72fps budget untouched.
  Verified in Chrome from level + steep-up angles: all four TOP ZAPPED rows stay visible at
  every pitch; scene-graph inspection confirms the render-order/position; no console errors.

**Speaker hub v1 (3.6)** — the booked speaker's home fills in; no new deps:
- **My slot** — your booked slot (time · title) + **Cancel booking** (frees the slot, **no
  refund**, inline confirm). Cancelling re-dims (closes) the hub.
- **Mic-queue control** — a **criteria toggle** (Money · Activity · Manual → `queue.setCriteria`),
  all three now implemented in the `queue` service:
  - **Money** (default) — highest cumulative zap first.
  - **Activity** — most board comments first (`board.byPubkey(pubkey).length`, ties → sats → joinedAt).
  - **Manual** — join order for display; each entry gets a **Pick** → `queue.next(pubkey)` (targeted).
  Changing criteria re-ranks the in-world pedestal queue panel too (it listens to `queue.onChange`).
- **Queue list** in the hub — ranked entrants (keyface · name · ⚡total · pitch). **Next questioner**
  → `queue.next()` (advances by the current criteria) → fires the existing pedestal "you're up" cue.
- Still **out of scope**: actual voice-role promotion at the pedestal — the cue only (as before).
- Verified flat in Chrome: with a booking the hub opens; Money→Activity re-ranks (seeded board
  comments differentiate); Manual shows Pick per entrant and picking fires the cue for that
  entrant; Next questioner advances; cancel re-dims the hub. No console errors. On-device-only:
  none new (flat DOM); the pedestal panel's live re-rank is best seen in VR. Rollback tag:
  `pre-3.6-speakerhub`.

**Book a slot — booking goes real-mock (3.5)** — the Stage home fills in; mock `booking` service, no new deps:
- **`booking` service (`src/booking/booking.js`)** — the single source of slot state, same
  pattern as the others. `slots` (an upcoming 30-min grid, flat 1,000 sats), `book`
  (charge via `wallet.zap`, **charge-on-confirmed**, sets `bookedBy`), `mine`, `cancel`
  (**no refund**), `nowAndNext`, `onChange`. Requires signed-in identity + connected
  wallet; a taken slot can't be double-booked; insufficient fails cleanly.
- **Booking surface (`src/ui/bookingUI.js`)** — replaces the stub with a real slot list
  (time · price · Free/Taken/Yours); pick a free slot → talk title → **Book & pay**; your
  slot shows distinctly.
- **Live Schedule** — the Stage menu's Now / Up next comes from `booking.nowAndNext()`
  (speaker name via identity + talk title); empty state stays graceful. Re-renders live
  while open.
- **Speaker hub gate** — the button **unlocks when you hold a booking** (opens a shell
  showing your slot, `src/ui/speakerHub.js`); dimmed + toast otherwise. Booking/Speaker-hub
  moved out of `menus.js` into their own modules.
- Verified flat in Chrome: book end-to-end (balance drops on confirmed), schedule shows it,
  **double-book blocked**, insufficient fails cleanly, **cancel frees the slot with no
  refund**, Speaker-hub button flips enabled. No console errors. On-device-only: none new
  (all flat DOM). Rollback tag: `pre-3.5-booking`.

**⚡ Take the mic — paid questioner queue** — flips the last dimmed spend-hub button live; mock `queue` service, no new deps:
- **`queue` service (`src/queue/queue.js`)** — the single source of queue state + ordering,
  same mock-first pattern as identity/wallet/board. `join`/`topUp` (charge via `wallet.zap`,
  **charge-on-confirmed**, amounts **accumulate**), `list`/`position`/`count`/`entry`,
  `criteria`/`setCriteria`, `remove`/`next`/`current`, `onChange`. Paying to enter is a zap
  with **no refunds**. Ordering is a **service parameter**: **Money implemented** (highest
  cumulative zap first, ties → earlier joiner); **Activity/Manual recognized but no-op** for a
  later Speaker-hub toggle. All queue state lives here — nowhere else.
- **Join flow** — spend hub → **⚡ Take the mic** (no longer dimmed) opens a form (amount
  presets + custom, optional ~80-char pitch). Joining charges the zap and adds you on
  `confirmed`; insufficient balance fails cleanly. Already in the queue → the button reads
  **"⚡ Mic queue: #N/M"** and the form switches to **Top up** (zap more to climb the ranking),
  with a live position line.
- **In-world queue panel (`src/room/queuePanel.js`)** — a small canvas-card panel at the
  pedestal/mic (VR-visible) showing the next few entrants (keyface + handle + ⚡total, pitch on
  the top entry). Re-textured on change only (72fps-safe). A **pedestal ring pulses when
  someone's "up"** (`queue.next()` → `current`), plus a toast (a personal one if it's you).
  Granting actual speak rights at the mic ties into voice-roles + host controls — a later slice.
- Guardrails: charging only through `wallet`; identities only through `identity`; no refunds
  logic; no voice-role changes; no "coming soon" copy (the criteria toggle simply doesn't
  exist yet). Verified flat in Chrome: join (balance drops on confirmed), position shows,
  **top-up re-ranks past a lower payer**, insufficient fails, panel updates in-world,
  `queue.next()` fires the you're-up cue, criteria parameterized. No console errors. Panel
  legibility / ring pulse / 72fps are **on-device-only**.

**Comment board v1** — two in-world 3D screens + post/boost, mock `board` service, no new deps:
- **`board` service (`src/board/board.js`)** — the single source of comments, keyed by
  **sender pubkey**, same mock-first pattern as identity/wallet (real Nostr notes + zap
  receipts later). `post`/`boost`/`get`/`recent`/`top`/`byPubkey`/`onChange`; ranked by
  zapped sats; seeded with a little content.
- **Two flanking screens (`src/room/commentBoard.js`)** — RIGHT = **LIVE** feed (recent
  comments, continuously scrolling up); LEFT = **TOP ZAPPED** wall (most-zapped, rank
  badges, sticky ~2 min). In-world so they show in VR. Cheap for Quest 72fps: one
  canvas-textured plane per card, re-textured only on post/boost; scroll is transform +
  opacity, ~10 meshes total.
- **Post a comment** — flips "Zap to comment" **live** in the spend hub → DOM compose
  form (140-char, editable sats cost). Posting **charges a zap** (to a house pubkey) and
  records to the board **only on `confirmed`**; carries the sender's identity.
- **Zap-to-boost** — aim at a comment card and trigger zap through the **one unified
  raycast** (desktop click · mobile tap · VR controller select): pays the comment's
  author + raises it on the top wall. Fixed 21-sat boost.
- **You → Activity** goes **live** — lists the comments you've sent.
- Also fixed a latent bug: the direct-ray pick paths (VR controller select + boost) now
  set `raycaster.camera`, so Sprites (name labels, zap bursts) don't throw on raycast.
- Guardrails: no per-user scrolling yet, no VR text entry yet (compose is flat/mobile
  DOM), no "coming soon" copy. Verified flat in Chrome: seeded feed + sorted top wall,
  post charges on confirmed, boost via raycast raises the card, insufficient balance
  posts nothing, Activity lists mine, no console errors. Screen legibility, continuous
  scroll feel, and 72fps are **on-device-only**.

**Menu shell — all five homes** — structural UI; every button in its home, live ones
wired, not-yet ones dimmed (toast "Not available yet", no "coming soon" copy). No new
backend features, no new deps. Design principle: a button lives where its target is.
- **Profile card** (on an avatar) — Visit · Follow · Zap, all live (unchanged).
- **Spend hub** (control-bar Zap → room actions only) — **Zap the speaker** (live when
  someone's on the stage disc, dimmed when empty), **Zap to comment** + **Take the mic**
  (dimmed → toast). Removed "Zap someone" (person-zapping is the card's job).
- **You menu** (new `You` control-bar chip) — identity (name + face), **Connect wallet +
  balance** (moved here as its home; balance still surfaces beside the Zap control),
  Activity (dim), Sign in / Switch / Log out (`identity.signIn`/`logout`).
- **Pause / Settings** (X · Esc·M · ☰) — added **Instructions** (live how-to panel) and
  **Share invite link** (live: copies `location.href`, toast "Link copied"); Resume,
  comfort toggles, Exit already existed.
- **Stage menu** (new `Stage` control-bar button) — Schedule (Now / Up next, "No one
  booked yet"), **Book a slot** (live → booking stub form), Speaker hub (dimmed seam).
- New module `src/ui/menus.js` (You/Stage/Instructions/Booking); `src/ui/zapUI.js`
  reworked to room-only. All full-screen surfaces are **one-at-a-time** (opening one
  closes the others; the corner profile card coexists). VR: these are DOM (invisible in
  immersive) — the in-world VR versions are the deferred VR-UI slice; VR entry/exit
  unaffected.
- Verified in real Chrome (flat): all five homes open + close each other; Zap-the-speaker
  dims on an empty stage (toast) and goes live with someone on it; every dim button
  toasts "Not available yet"; You connect → balance; Book opens the stub; Instructions
  opens; no console errors. (Share's clipboard write needs a focused real gesture — it
  falls back to surfacing the URL; works on a genuine click.)

**Phase 3 — mock wallet + zap-a-person** — Lightning-shaped, no real Lightning, no new deps:
- **`wallet` service (`src/wallet/wallet.js`)** — the ONE source of balance + zaps,
  SEPARATE from identity (signing ≠ paying). `connect()` → fake 21,000 sats ·
  `getBalance()` · `zap({ toPubkey, amountSats, note })` async through
  **pending → confirmed | failed** · `onZap(cb)` · `disconnect()` · `isConnected()`.
  Shape matches the real swap: zap is async with ~1s pending; keyed by pubkey + amount
  + note (NIP-57); **reads the recipient's `lud16` via `identity.getProfile()`** before
  paying (plumbing for real LNURL→invoice); **balance decrements only on `confirmed`**;
  **insufficient balance → `failed`**. Swapping in NWC/LNbits touches only this file.
- **Zap a person (one unified flow)** — the profile-card Zap, the control-bar Zap, and
  the **Y** binding all funnel through one `zapAvatar`: flat/mobile opens an **amount
  picker** (21 / 100 / 1000 + custom → confirm), VR **quick-zaps** a default (21) to the
  selected avatar with no DOM. Zapping is connect-gated (prompts the hub if no wallet).
- **Spend-menu hub** (control-bar Zap) — home for sats actions: Connect wallet / live
  balance, **⚡ Zap someone** (live), and disabled **Zap to comment / Zap to request to
  speak** ("— soon") placeholders. Small balance readout sits beside the Zap control.
- **In-world zap feedback (`src/room/zapEffect.js`)** — a ⚡+amount burst on the zapped
  avatar, parented in-world so it shows in **VR** too; built on the event, disposed after
  ~0.9s, **zero per-frame cost when idle** (72fps-safe). Flat/mobile also get a toast.
- Verified in real Chrome: connect → 21,000; zap 100 → pending→confirmed, balance 20,900
  + in-world ⚡; zap 999,999 → failed (insufficient), balance unchanged; reads `lud16`;
  full UI path (hub → connect → picker → send 1,000 → 20,000). No console errors.
  VR quick-zap feel is on-device-only.

**Controller & Input Standard alignment** — conform to the webxr-threejs cross-reality
input standard; gameplay unchanged, only bindings/architecture (no new deps):
- **Locomotion:** left stick / WASD move; speeds now **fixed walk 1.4 / sprint 2.8 m/s**
  — analog inputs (VR stick, mobile joystick) sprint by **magnitude** (full push),
  keyboard sprints with **Shift**. Right stick = **smooth (softly-eased) turn** by
  default (snap is now an opt-in comfort toggle, no longer baked on). **Fly** (right-
  stick click / **F** / mobile btn) is fully wired behind **`ENABLE_FLY`** —
  **off** for this grounded venue (`?fly=1` to try).
- **Buttons (canonical map):** **A = jump** (was left Y), **X = Pause/Menu**, triggers =
  select, **grips = grab**, **B = toggle mic (Listen/Speak)**, **Y = zap** — this game's
  two free verbs, bound on VR + desktop key + the existing on-screen control-bar buttons.
- **Cross-input parity:** every verb bound on all three realities — desktop **Esc**(primary)/
  **M** menu, **E-hold / right-click** grab, **Shift** sprint, **F** fly; mobile joystick-
  to-edge sprint + the **☰** menu button. Grab is an **inert seam** (no grabbable props
  yet — wired on grip/E/right-click, no-op + toast until a future slice adds objects).
- **Pause/Menu (X · Esc·M · ☰):** Resume · Exit to screen mode · comfort toggles. DOM
  panel for flat/mobile; the VR X button opens it too (in-world VR menu panel deferred,
  like the VR profile card — platform button still exits VR regardless).
- **Comfort layer (`input/comfort.js`):** vignette · snap turn · haptics — **ALL OFF by
  default**, opt-in via the menu, **persisted** to `localStorage`. Speeds are fixed, not
  a comfort toggle ("don't nanny").
- **Exit:** no custom X/A "exit VR/AR" binding (there wasn't one) — exit = platform button
  + the menu's "Exit to screen mode".
- **AR shell-off (`EnvironmentAdapter`):** scene split into a **shell** (sky/floor/grid/
  backdrop/beam/fog) vs **props** (stage/mic/rings); AR suppresses the whole shell via
  `environment.setShellVisible(false)` and swaps room-bounds clamping for **per-prop
  collision** (`constrainPosition(..., ar)` drops the outer radius + front wall, keeps
  the stage/platform exclusions). Flat/VR untouched.
- Verified in real Chrome (flat): walk 1.4 / sprint 2.8 m/s, drag-look turn, jump
  ~0.47 m peak + lands back, Esc/M menu open/close, comfort toggle **persists across
  reload**, E / right-click grab, no console errors. VR/AR feel is on-device-only.

**Card reposition + two XR input fixes** — no new deps:
- Profile card moved to the **lower-right**, anchored to the bottom-right with
  safe-area insets (above the control bar; `--control-bar-h` on mobile) — no longer
  vertically centered, so it doesn't cover the stage/centre. Same size/content/
  one-at-a-time/handlers.
- **VR stick mapping fixed** (was backwards): **left stick = walk/locomotion, right
  stick = turn** (snap). Jump unchanged (left controller Y).
- **XR controller select** now works: each controller has a visible orange **aiming
  ray** (hidden until it connects in-session), and its `select` (and AR screen-tap)
  feeds the **same `pickFromRaycaster`** as the desktop click — one unified
  "select avatar" path. The selection-ring cue shows in XR even though the DOM card
  is flat/mobile-only (head-anchored VR card is still deferred).

**Phase 2.3 — profile card → fixed corner panel** — readable regardless of distance:
- The card is now a **fixed DOM panel** (right-centre, constant size/position) instead
  of an in-world billboard, so a far avatar's card is just as readable as a near one.
  Clicking an avatar still selects it (same 2.2 raycast/click-to-interact); a
  **selection ring** is parented to the picked avatar so it's clear who the card is for.
- The in-world card meshes are **gone** — `ui/profileCard.js` is now DOM-only (no
  THREE), so there's no per-open geometry/material/texture to leak.
- Unchanged from 2.2: one card at a time (X / empty / re-click closes), content from
  `identity.getProfile` (keyface, name, npub-short, nip05), and the **same named
  handlers** `onVisit` (njump) / `onFollow` (mock toggle) / `onZap` (wallet stub) —
  just moved into the fixed card. Data + handlers stay separate from the container so
  the deferred **VR card** (camera-anchored) plugs into the same handlers.

**Phase 2.2 — click an avatar → in-world profile card** — mock actions, no new deps:
- A plain click raycasts to an avatar and opens its **in-world 3D profile card** (a
  billboarded panel — works in flat/VR/AR, not a DOM overlay). Hold-drag still looks;
  pointer-lock (Free look) is unchanged and the click stays free (the skill's rule).
  VR uses the controller `select` ray.
- Card (data from `identity.getProfile`): keyface/picture, name, npub-short, nip05,
  an **X** close, and three actions. **One card at a time** (opening another closes
  the previous); clicking the same avatar / empty space closes it. Built on open,
  **disposed on close** (no orphaned meshes/textures); canvas redrawn only on
  open/change, never per frame — billboard is a per-frame quaternion copy.
- Actions behind **named handlers** so real swaps are contained: **Visit profile** →
  `https://njump.me/<npub>` (desktop; no-op in VR), **Follow** ⇄ **Following** (mock
  toggle stored in the identity layer; real = kind:3), **⚡ Zap** → stub routed to the
  not-yet-built wallet service (dimmed; "Wallet coming soon"). New
  [ui/profileCard.js](web/src/ui/profileCard.js); identity is the only data source.

**Phase 2 — mock identity (Nostr-shaped)** — no real keys/relays/network:
- New **`identity` service** ([identity/identity.js](web/src/identity/identity.js)) is
  the single source of identity: `signIn(method)`, `current()`, `getProfile(pubkey)`
  (async), `signEvent(event)` (async), `logout()`. Everything is **pubkey-keyed**,
  mock data is **deterministic** from the pubkey (stable across reloads), and the
  `Identity` carries **`lud16`** for future zaps. Mock now, but the surface matches
  real Nostr so swapping in nostr-tools + NIP-07 is a module swap — callers don't change.
- Every avatar (seeded ambiance + live presence peers) is assigned a stable mock
  identity via the service (id → pubkey → profile), as a data layer over the
  existing bodies — movement/presence logic untouched (`onAvatarSpawn` hook).
- Avatars render identity: a deterministic **keyface** identicon
  ([identity/keyface.js](web/src/identity/keyface.js)) on the `faceMount` disc (or
  `getProfile().picture` when real), plus an over-head **name label** sprite.
- **Sign in** control (mock `guest`) → sets `current()` and shows a compact
  "signed in as …" chip (keyface + name). `method` param kept (real: nip07 desktop /
  generate mobile+VR). No new deps; voice/presence/movement/modes/scene unchanged.

**Mobile control-bar docking** — mobile-only positioning, desktop unchanged:
- The control bar now docks **flush to the bottom edge** on mobile
  (`bottom: calc(env(safe-area-inset-bottom) + 8px)`) — it was floating mid-screen
  because of an old "lift above the joystick" offset (`+124px`).
- The joystick floats **just above the bar**, offset by the bar's live height:
  a `ResizeObserver` in main.js publishes `--control-bar-h` (1 row landscape, 2 rows
  portrait) and the joystick (and toast/error) use
  `bottom: calc(env(safe-area-inset-bottom) + var(--control-bar-h) + 16px)`, so it
  always clears the bar in either orientation. 1.12 viewport handling untouched.

**Mobile viewport fix** — no behavior change beyond viewport sizing:
- The canvas + overlay now track the **live visual viewport**, fixing the mobile
  black band (portrait/landscape, after rotation or URL-bar show/hide) and the
  control bar floating mid-screen.
- Canvas is `position:fixed; inset:0; width:100vw; height:100dvh` (dynamic viewport
  height tracks browser-chrome show/hide). `syncViewport()` measures
  `window.visualViewport` (fallback `inner*`) and calls `renderer.setSize(w,h,false)`
  (no stale inline styles — CSS owns display size) + DPR + camera aspect, fired on
  `resize` / `orientationchange` (with a settle re-measure) / `visualViewport`
  `resize`+`scroll`, rAF-debounced.
- Overlay anchored to the viewport (`#hud` height `100dvh`); top bar / control bar /
  joystick positioned with `env(safe-area-inset-*)` (notch + home indicator).
  Desktop positions unchanged (insets are 0 there).

**Visual design pass — "Live Console"** — visual/CSS + tokens only, no behavior change:
- Established a reusable **CSS token system** (palette, type, spacing, radii,
  elevation, motion) in `web/index.html` so Phase 2+ surfaces inherit the look.
  Bitcoin-orange primary accent; Nostr-violet reserved for identity (used now as
  the keyboard-focus ring); state LEDs for ok/warn/bad.
- Restyled every HUD surface to a **broadcast/control-surface** language:
  translucent glass panels (blur + hairline + inset highlight), **monospace
  instrument readouts** (room · connection · counts, tabular nums), an uppercase
  **mode channel selector**, a **tally-light** system (the connection LED pulses
  when live; active mode + "on" controls get an orange on-air glow), and a thin
  orange "energy line" on the control bar.
- Swapped the emoji glyphs (⌂ 👥 🎙 ⚡) for monochrome inline SVG icons
  (`currentColor`) — purely presentational; all dynamic text spans untouched.
- A11y floor: `:focus-visible` rings (violet) and `prefers-reduced-motion` honored.
- Control bar now uses `width: max-content` (capped by `max-width`) so it's a single
  row on wide screens and wraps to ≤2 tidy rows on narrow — the originally-intended
  responsive behavior (was wrapping early on desktop since Free look was added).
  No IDs/classes/structure or responsive logic otherwise changed.

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
