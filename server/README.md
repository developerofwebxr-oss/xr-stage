# XR Stage — token server

Tiny stateless Node/Express service that mints short-lived **LiveKit** access
tokens for the spatial-stage client. It holds the LiveKit API key + secret (from
env); the browser never sees them — it only ever receives a signed JWT.

## Endpoints

| Method | Path     | Body                          | Returns |
|--------|----------|-------------------------------|---------|
| GET    | `/health`| —                             | `{ ok: true }` |
| POST   | `/token` | `{ room, identity, role }`    | `{ token, identity, role, room }` |

`role: "speaker"` → token carries `canPublish` (may publish mic audio).
Any other role → `listener`: subscribe + data only, no publish. The grant is
decided here at mint time, not trusted from the client.

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
