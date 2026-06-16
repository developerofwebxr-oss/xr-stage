import { Room, RoomEvent } from 'livekit-client';
import { config } from '../config.js';

// voice/livekit.js — the room's live audio + the shared data pipe, in one client.
//
// Responsibilities:
//   • Fetch a token from our backend (server/) for {room, identity, role}.
//   • Connect to the LiveKit SFU and, if we're the speaker, publish the mic.
//   • Auto-attach every subscribed remote audio track so listeners hear speakers.
//   • Expose a tiny data-channel API (sendData/onData) that presence.js rides on —
//     this is the same pipe later prompts reuse for stage state, zaps, etc.
//
// Audio is plain stereo for now. SEAM: spatialising the speaker at the stage
// position would attach the track to a THREE.PositionalAudio instead of an <audio>
// element here — the rest of the app wouldn't change.
//
// No secrets here: we only ever hold a short-lived JWT the server minted.

// Log the resolved token endpoint exactly once per page load (debugging aid for
// path mismatches), no matter how many times the user clicks Join voice.
let loggedTokenUrl = false;

export class Voice {
  constructor({ onCounts, onState } = {}) {
    this.room = null;
    this.onCounts = onCounts || (() => {});
    // Connection-state callback: 'idle' | 'connecting' | 'connected' | 'failed'.
    this.onState = onState || (() => {});
    this._dataHandlers = new Set();
    this._decoder = new TextDecoder();
    this._encoder = new TextEncoder();
  }

  // Ask the backend for a token, then join + publish/subscribe. Resolves once
  // connected. Each step is wrapped so a failure throws a SHORT, human reason
  // (the message shown in the HUD); the underlying error is logged to the console.
  // On any failure the connection is torn down so the user can retry cleanly.
  async connect() {
    if (this.room) return; // already joined / joining
    this.onState('connecting');

    try {
      // Fail fast with a clear setup error rather than a confusing network error.
      if (!config.tokenUrl) throw short('VITE_TOKEN_URL not set', null);
      if (!config.livekitUrl) throw short('VITE_LIVEKIT_URL not set', null);

      const token = await this._fetchToken();

      const room = new Room({ adaptiveStream: true, dynacast: true });
      this.room = room;

      room
        .on(RoomEvent.TrackSubscribed, (track) => {
          // Attach audio so it actually plays; ignore any (future) video tracks.
          if (track.kind === 'audio') {
            const el = track.attach();
            el.setAttribute('data-livekit', 'audio');
            document.body.appendChild(el);
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()))
        .on(RoomEvent.DataReceived, (payload, participant) => {
          const id = participant ? participant.identity : 'unknown';
          let msg;
          try { msg = JSON.parse(this._decoder.decode(payload)); } catch { return; }
          for (const fn of this._dataHandlers) fn(id, msg);
        })
        .on(RoomEvent.ParticipantConnected, () => this._emitCounts())
        .on(RoomEvent.ParticipantDisconnected, () => this._emitCounts())
        .on(RoomEvent.ActiveSpeakersChanged, () => this._emitCounts())
        .on(RoomEvent.Disconnected, () => this.onState('failed'));

      try {
        await room.connect(config.livekitUrl, token);
      } catch (err) {
        throw short('connect failed', err);
      }

      // Speakers publish their mic on join; listeners never do (and the token's
      // grants forbid it server-side regardless, so this is belt-and-suspenders).
      if (config.role === 'speaker') {
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
        } catch (err) {
          throw short('mic denied', err);
        }
      }

      this.onState('connected');
      this._emitCounts();
    } catch (err) {
      // Log the real error for debugging; tear down so retry starts fresh.
      console.error('[voice] connect error:', err.cause || err);
      if (this.room) { try { await this.room.disconnect(); } catch { /* ignore */ } this.room = null; }
      this.onState('failed');
      throw err;
    }
  }

  // Speaker mic toggle. No-op for listeners (and the grant blocks publish anyway).
  async setMuted(muted) {
    if (!this.room || config.role !== 'speaker') return;
    await this.room.localParticipant.setMicrophoneEnabled(!muted);
  }

  // Broadcast a small JS object to everyone over the lossy data channel.
  // reliable:false is right for high-rate presence — drop a frame, send the next.
  sendData(obj, { reliable = false } = {}) {
    if (!this.room) return;
    const bytes = this._encoder.encode(JSON.stringify(obj));
    this.room.localParticipant.publishData(bytes, { reliable });
  }

  // Subscribe to inbound data messages: fn(senderIdentity, parsedObject).
  onData(fn) {
    this._dataHandlers.add(fn);
    return () => this._dataHandlers.delete(fn);
  }

  async disconnect() {
    if (!this.room) return;
    await this.room.disconnect();
    this.room = null;
  }

  // ── internals ────────────────────────────────────────────────────────────────
  _emitCounts() {
    const room = this.room;
    if (!room) return;
    const participantCount = room.remoteParticipants.size + 1; // +1 = us
    const speakerCount = room.activeSpeakers.length;
    this.onCounts({ participantCount, speakerCount });
  }

  async _fetchToken() {
    // VITE_TOKEN_URL is the FULL endpoint — fetch it as-is, never append "/token".
    const url = config.tokenUrl;
    if (!loggedTokenUrl) { console.log('[voice] token endpoint:', url); loggedTokenUrl = true; }

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: config.room, identity: config.identity, role: config.role }),
      });
    } catch (err) {
      // Network-level failure (server down, CORS, bad URL, offline).
      throw short('token fetch failed', err);
    }
    if (!res.ok) throw short(`token fetch failed (${res.status})`, new Error(await res.text().catch(() => '')));
    const { token } = await res.json().catch(() => ({}));
    if (!token) throw short('token response invalid', null);
    return token;
  }
}

// Build an Error carrying a SHORT, user-facing message plus the original cause for
// the console log.
function short(message, cause) {
  const e = new Error(message);
  if (cause) e.cause = cause;
  return e;
}
