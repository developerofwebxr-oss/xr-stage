# XR Stage — token server

Tiny stateless Node/Express service that mints short-lived **LiveKit** access
tokens for the spatial-stage client. It holds the LiveKit API key + secret (from
env); the browser never sees them — it only ever receives a signed JWT.

## Endpoints

| Method | Path              | Body                                          | Returns |
|--------|-------------------|-----------------------------------------------|---------|
| GET    | `/health`         | —                                             | `{ ok: true }` |
| POST   | `/token`          | `{ room, identity, role }`                    | `{ token, identity, role, room }` |
| POST   | `/session-code`   | `{ pubkey, name, picture?, nip05?, lud16? }`  | `{ code, expiresAt }` |
| POST   | `/session-redeem` | `{ code }`                                    | `{ pubkey, name, … }` or `400/404/410/429` |

`role: "speaker"` → token carries `canPublish` (may publish mic audio).
Any other role → `listener`: subscribe + data only, no publish. The grant is
decided here at mint time, not trusted from the client.

### Headset login (`/session-*`, see `session.js`)

Cross-device pairing so a signed-in phone/desktop can hand its identity to a
headset: mint a 6-digit **code** bound to the caller's **public** identity
profile, redeem it on the headset to adopt that identity (balance follows via the
client's per-pubkey persistence). **No keys or secrets are ever accepted or
stored** — the payload is public display fields only; unknown body fields are
dropped. Codes are **single-use** (deleted on first redeem), TTL **~5 min**
(purged after), and redeem is **rate-limited to 10/min per IP**. In-memory only
(no DB): a restart drops outstanding codes, which is fine for short-lived pairing
tokens. `SESSION_TTL_MS` overrides the TTL (tests).

## Run

```bash
npm install
cp .env.example .env   # fill in LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
npm start              # → http://localhost:8080
```

```bash
curl -X POST http://localhost:8080/token \
  -H 'content-type: application/json' \
  -d '{"room":"main-stage","identity":"alice","role":"speaker"}'
```

## Deploy (Railway)

Start command `npm start`; Railway injects `PORT`. Set in the Variables tab:
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `ALLOWED_ORIGIN`
(your GitHub Pages origin). Never commit real keys.

The `/session-*` endpoints need **no new env** and add **no dependencies** (the
6-digit codes use Node's built-in `crypto.randomInt`). `app.set('trust proxy')`
is on so the redeem rate limit sees the real client IP behind Railway's proxy.
Redeploy is just a push — same service, two more routes.
