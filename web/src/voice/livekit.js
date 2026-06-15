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

export class Voice {
  constructor({ onCounts } = {}) {
    this.room = null;
    this.onCounts = onCounts || (() => {});
    this._dataHandlers = new Set();
    this._decoder = new TextDecoder();
    this._encoder = new TextEncoder();
  }

  // Ask the backend for a token, then join. Resolves once connected.
  async connect() {
    if (this.room) return; // already joined / joining

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
      .on(RoomEvent.ActiveSpeakersChanged, () => this._emitCounts());

    await room.connect(config.livekitUrl, token);

    // Speakers publish their mic on join; listeners never do (and the token's
    // grants forbid it server-side regardless, so this is belt-and-suspenders).
    if (config.role === 'speaker') {
      await room.localParticipant.setMicrophoneEnabled(true);
    }

    this._emitCounts();
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
    const res = await fetch(`${config.tokenUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: config.room, identity: config.identity, role: config.role }),
    });
    if (!res.ok) throw new Error(`token request failed (${res.status}): ${await res.text()}`);
    const { token } = await res.json();
    if (!token) throw new Error('token response missing "token"');
    return token;
  }
}
