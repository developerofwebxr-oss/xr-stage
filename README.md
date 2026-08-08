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
