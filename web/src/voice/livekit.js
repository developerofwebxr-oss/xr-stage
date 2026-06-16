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
    // Attached <audio> elements for remote speakers + whether playback is on. The
    // listener's "Listen" toggle flips _audioEnabled; speakers leave it on so they
    // hear the room. Mic publish is separate (setMicEnabled).
    this._audioEls = new Set();
    this._audioEnabled = true;
  }

  get isConnected() { return !!this.room; }

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
          // Attach audio so it plays; ignore any (future) video tracks. Respect the
          // current playback state so a listener with Listen:off doesn't hear it.
          if (track.kind === 'audio') {
            const el = track.attach();
            el.setAttribute('data-livekit', 'audio');
            el.muted = !this._audioEnabled;
            this._audioEls.add(el);
            document.body.appendChild(el);
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => {
          this._audioEls.delete(el);
          el.remove();
        }))
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

      // No publishing here: the mic is controlled by the speaker's "Speak" toggle
      // (setMicEnabled), and audio playback by the listener's "Listen" toggle.
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

  // Speaker "Speak" toggle: publish or unpublish the mic. No-op for listeners (the
  // token grant blocks publish anyway). Throws 'mic denied' if the user blocks the
  // mic permission, so the HUD can surface it.
  async setMicEnabled(on) {
    if (!this.room || config.role !== 'speaker') return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(on);
    } catch (err) {
      throw short('mic denied', err);
    }
  }

  // Listener "Listen" toggle: start/stop hearing the room. Mutes/unmutes the
  // attached audio elements; turning it on also resumes the audio context (the
  // browser autoplay gesture is satisfied by the click that calls this).
  async setListening(on) {
    this._audioEnabled = on;
    for (const el of this._audioEls) el.muted = !on;
    if (on && this.room) {
      try { await this.room.startAudio(); } catch { /* gesture already covers it */ }
    }
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
