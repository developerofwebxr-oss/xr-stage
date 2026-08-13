import { config } from '../config.js';

// audio/zoneAudio.js — proximity voice + zone isolation (Prompt 4.4), layered OVER the
// stage voice system (voice/livekit.js), never forking it. ONE LiveKit room, no new
// tokens/rooms. The whole feature lives behind this seam.
//
// Mechanism (the important part):
//   • METADATA over the presence heartbeat: every client already broadcasts its `zone`
//     id (state/presence.js). So each client knows, per participant, which social zone
//     they're in — no LiveKit metadata/track-name plumbing needed.
//   • SUBSCRIBE/RENDER selection = local gain: we keep LiveKit's auto-subscribe, then set
//     each remote <audio> element's VOLUME by (a) does the publisher's zone match mine,
//     and (b) proximity falloff. A track whose publisher is outside my zone → volume 0
//     (not rendered). The stage track (publisher in NO zone) stays audible everywhere
//     (config.zoneHearsStage) — it's a venue, the talk carries.
//   • NETWORKING is doubly gated: audible only across an ACTIVE talk-link (mutual accept
//     over the data channel), then proximity-scaled; either side can end it.
//
// The local <audio> `.muted` stays owned by the stage Listen toggle; we only touch
// `.volume`, so the two compose cleanly (effective = Listen ? volume : silent).
//
//   createZoneAudio({ voice, myIdentity, getLocalPos, getPeers, onTalkRequest, onLinksChanged, toast })
//     setZone(zoneId) · requestTalk(id) · acceptTalk(id) · declineTalk(id) · endTalk(id)
//     onTalkRequest(cb) · update(dt) · myZone() · hasLink(id) · pendingIncoming() · outgoing()

const R = config.zoneFalloffM;              // metres to silence
const GAIN_INTERVAL = 1000 / config.zoneGainHz;

export function createZoneAudio({ voice, myIdentity, getLocalPos, getPeers, onTalkRequest, onLinksChanged, toast } = {}) {
  let myZone = null;                         // null = plaza/stage
  const links = new Set();                   // peer ids in an active networking talk-link
  const incoming = new Map();                // fromId → { name } — requests awaiting my accept
  const outgoing = new Set();                // ids I've asked, awaiting their accept
  const reqHandlers = new Set();
  if (onTalkRequest) reqHandlers.add(onTalkRequest);
  let gainAcc = 0;

  // Inbound talk-link signalling (same lossy pipe presence rides). id = sender identity.
  voice.onData((id, msg) => {
    if (!msg || msg.t !== 'talk' || msg.to !== myIdentity) return;
    if (msg.kind === 'req') {
      incoming.set(id, { name: msg.name || null });
      for (const fn of reqHandlers) fn({ from: id, name: msg.name || null });
    } else if (msg.kind === 'accept') {          // they accepted MY request
      outgoing.delete(id);
      links.add(id);
      updateMic();
      notifyLinks();
      toast && toast('Talk link open');
    } else if (msg.kind === 'end') {
      links.delete(id);
      updateMic();
      notifyLinks();
    }
  });

  const send = (to, kind, extra = {}) => voice.sendData({ t: 'talk', to, kind, from: myIdentity, ...extra }, { reliable: true });
  const notifyLinks = () => onLinksChanged && onLinksChanged([...links]);

  // My mic should publish in an OPEN-MIC zone (Smoking or Backstage), OR in Networking with
  // ≥1 live talk-link. Plaza/stage never auto-publish here (the stage mic is the speaker's
  // own Speak toggle). Connects on demand within the entry gesture.
  function shouldPublish() {
    return myZone === 'smoking' || myZone === 'backstage' || (myZone === 'networking' && links.size > 0);
  }
  async function updateMic() {
    const want = shouldPublish();
    try {
      if (want && !voice.isConnected) { await voice.connect(); await voice.setListening(true); }
      if (voice.isConnected) await voice.setZoneMic(want);
    } catch (err) {
      // Mic permission denied (or no publish grant) — surface once; caller bounces on entry.
      toast && toast(err?.message === 'mic denied' ? 'Mic permission needed for this zone' : 'Zone mic unavailable');
      throw err;
    }
  }

  // Enter/leave a zone. Called from the zone enter/leave seam (for Smoking, AFTER the mic
  // confirm, so the publish happens inside that click gesture). Leaving ends any links.
  async function setZone(zoneId) {
    if (zoneId === myZone) return;
    const left = myZone;
    myZone = zoneId || null;
    if (left === 'networking' && myZone !== 'networking') {   // leaving networking → drop links
      for (const id of links) send(id, 'end');
      links.clear(); outgoing.clear(); incoming.clear();
      notifyLinks();
    }
    await updateMic();      // publish (smoking) / unpublish (left smoking, no links)
  }

  // Networking talk-link handshake (mutual permission).
  function requestTalk(id, name) { if (id) { outgoing.add(id); send(id, 'req', { name: name || null }); toast && toast('Asked to talk — waiting…'); } }
  function acceptTalk(id) { if (!id) return; incoming.delete(id); links.add(id); send(id, 'accept'); updateMic(); notifyLinks(); }
  function declineTalk(id) { incoming.delete(id); send(id, 'end'); }
  function endTalk(id) { if (!links.has(id)) return; links.delete(id); send(id, 'end'); updateMic(); notifyLinks(); }

  const onTalkRequestCb = (cb) => { reqHandlers.add(cb); return () => reqHandlers.delete(cb); };

  // Smoothstep falloff: full at the source, silent by R metres. Closer = louder.
  function falloff(d) {
    const t = Math.min(1, Math.max(0, d / R));
    return 1 - t * t * (3 - 2 * t);
  }

  // Per-participant gain — the render-selection + proximity pass. Throttled to
  // config.zoneGainHz (NOT per-frame), fed by presence positions/zones.
  function update(dt) {
    gainAcc += dt * 1000;
    if (gainAcc < GAIN_INTERVAL) return;
    gainAcc = 0;
    if (!voice.isConnected) return;

    const me = getLocalPos();
    const peerById = new Map();
    for (const p of getPeers()) peerById.set(p.id, p);

    voice.eachRemoteAudio((id, el) => {
      const peer = id ? peerById.get(id) : null;
      const zone = peer ? peer.zone : null;
      let gain;
      if (!zone) {
        // Publisher is in no social zone → the stage (audience mics are off in plaza).
        gain = config.zoneHearsStage ? 1 : 0;               // global, not distance-scaled
      } else if (zone !== myZone) {
        gain = 0;                                           // other zone → not rendered
      } else if (zone === 'networking' && !links.has(id)) {
        gain = 0;                                           // networking needs a talk-link
      } else {
        const dx = peer.group.position.x - me.x, dz = peer.group.position.z - me.z;
        gain = falloff(Math.hypot(dx, dz));                 // same zone → proximity
      }
      el.volume = gain;
    });
  }

  return {
    setZone, requestTalk, acceptTalk, declineTalk, endTalk, onTalkRequest: onTalkRequestCb, update,
    myZone: () => myZone,
    hasLink: (id) => links.has(id),
    pendingIncoming: () => [...incoming.entries()].map(([id, v]) => ({ id, name: v.name })),
    outgoing: () => [...outgoing],
  };
}
