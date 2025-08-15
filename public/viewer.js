// public/viewer.js
import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

const el = (id) => document.getElementById(id);
const toast = (t) => { const x = el('toast'); if (!x) return; x.textContent = t; x.style.display='block'; setTimeout(()=>x.style.display='none', 1600); };

// --- Channel from URL (?ch=b1|b2)
function getChannelId() {
  const ch = new URLSearchParams(location.search).get('ch');
  return ['b1','b2'].includes(ch) ? ch : null;
}
const channelId = getChannelId();
if (channelId) document.title = (channelId === 'b1' ? 'Broadcaster 1' : 'Broadcaster 2') + ' • Watch';

const socket = io();
let device, recvTransport;
const mediaStream = new MediaStream();
let videoConsumer = null, audioConsumer = null;

let statsTimer = null, lastBytes = 0, lastTs = 0;

// optional: if you later add an external quality selector with id="qualitySel"
const qualitySel = document.getElementById('qualitySel');
let supportsQualityMenu = true;

// skeleton / loading
function skeleton(show){
  const sk = el('skel'), v = el('remote');
  if (sk) sk.style.display = show ? 'block' : 'none';
  if (v)  v.style.display  = show ? 'none'  : 'block';
}

// quality badge (network)
function setQualityBadge(kbps, plr){
  const q = el('quality'); if (!q) return;
  let cls = 'badge quality ';
  let txt = `~${Math.round(kbps)} kbps`;
  if (plr >= 5 || kbps < 200) { cls += 'bad'; txt += ' • Poor'; }
  else if (plr >= 2 || kbps < 600) { cls += 'warn'; txt += ' • Fair'; }
  else { cls += 'ok'; txt += ' • Good'; }
  q.className = cls; q.textContent = txt;
}

async function loadDevice(){
  const caps = await new Promise(res => socket.emit('getRtpCapabilities', res));
  device = new mediasoupClient.Device(); await device.load({ routerRtpCapabilities: caps });

  // if you decide to gate the external quality menu by codec support
  const hasVp8 = device.rtpCapabilities.codecs.some(c => /video\/VP8/i.test(c.mimeType));
  if (!hasVp8 && qualitySel) { supportsQualityMenu = false; qualitySel.disabled = true; qualitySel.title = 'Quality not available on this device'; }
}

async function makeRecvTransport() {
  const params = await new Promise(res => socket.emit('createRecvTransport', { channelId }, res));
  if (params?.error) throw new Error(params.error);
  const t = device.createRecvTransport(params);
  t.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.emit('connectRecvTransport', { channelId, dtlsParameters }, (r)=> r==='ok' ? callback() : errback(new Error('connect failed')));
  });
  return t;
}

function attachTrack(kind, track){
  const v = el('remote');
  if (kind === 'video') { const old = mediaStream.getVideoTracks()[0]; if (old) mediaStream.removeTrack(old); mediaStream.addTrack(track); }
  else { const old = mediaStream.getAudioTracks()[0]; if (old) mediaStream.removeTrack(old); mediaStream.addTrack(track); }
  if (v && !v.srcObject) v.srcObject = mediaStream;
}

async function consumeKind(kind) {
  const data = await new Promise(res => socket.emit('consume', { channelId, rtpCapabilities: device.rtpCapabilities, kind }, res));
  if (data?.error) { if (kind === 'video') { const live = el('live'); if (live) live.textContent = 'Waiting for broadcaster…'; } return null; }
  const consumer = await recvTransport.consume(data);
  attachTrack(kind, consumer.track);
  await new Promise(res => socket.emit('resume', { consumerId: consumer.id }, res));

  consumer.on('producerclose', async () => { try { await reconsume(kind); } catch(e){ console.error(e); } });

  if (kind === 'video') {
    const r = el('res'); if (r) r.textContent = '720p'; // static label; you can compute from stats if you want
  }
  return consumer;
}

async function reconsume(kind){
  const data = await new Promise(res => socket.emit('consume', { channelId, rtpCapabilities: device.rtpCapabilities, kind }, res));
  if (data?.error) return;
  const newConsumer = await recvTransport.consume(data);
  attachTrack(kind, newConsumer.track);
  await new Promise(res => socket.emit('resume', { consumerId: newConsumer.id }, res));
  if (kind === 'video') { try{ videoConsumer?.close(); }catch{} videoConsumer = newConsumer; }
  else { try{ audioConsumer?.close(); }catch{} audioConsumer = newConsumer; }
}

function startStats(){
  if (statsTimer) clearInterval(statsTimer);
  lastBytes = 0; lastTs = 0;
  statsTimer = setInterval(async ()=>{
    if (!videoConsumer) return;
    const stats = await videoConsumer.getStats();
    let bytes=0, timestamp=0, pl=0, pr=0;
    stats.forEach(s => { if (s.type === 'inbound-rtp' && !s.isRemote) { bytes = s.bytesReceived; timestamp = s.timestamp; pl = s.packetsLost || 0; pr = s.packetsReceived || 0; }});
    if (lastTs && timestamp && bytes >= lastBytes) {
      const kbps = ((bytes - lastBytes) * 8) / ((timestamp - lastTs) / 1000) / 1000;
      const plr = pr > 0 ? (pl / (pr + pl)) * 100 : 0;
      setQualityBadge(kbps, plr);
    }
    lastBytes = bytes; lastTs = timestamp;
  }, 3000);
}

async function watch() {
  if (!channelId) { const s = el('status'); if (s) s.textContent = 'Pick a channel (?ch=b1 or ?ch=b2)'; return; }
  try {
    const s = el('status'); if (s) s.textContent = 'Connecting…'; skeleton(true);
    await new Promise(res => socket.emit('join', { channelId }, res));
    await loadDevice();
    recvTransport = await makeRecvTransport();
    videoConsumer = await consumeKind('video');
    audioConsumer = await consumeKind('audio');
    const live = el('live');
    if (videoConsumer) { if (live) live.textContent = 'LIVE'; skeleton(false); startStats(); }
    else { if (live) live.textContent = 'Waiting for broadcaster…'; }
    if (s) s.textContent = '📺 Watching';
  } catch (e) { console.error(e); const s = el('status'); if (s) s.textContent = e.message || 'Error starting viewer'; }
}

// server notifications
socket.on('newProducer', async ({ channelId: cid, kind }) => {
  if (cid && cid !== channelId) return;
  if (!device || !recvTransport) return;
  try { await reconsume(kind); } catch(e){ console.error(e); }
});
socket.on('viewerCount', ({ count }) => { const v = el('vc'); if (v) v.textContent = `👀 ${count}`; });
socket.on('connect', () => toast('Connected'));
socket.io.on('reconnect_attempt', () => toast('Reconnecting…'));
socket.on('disconnect', () => toast('Disconnected'));

// (optional) external quality menu outside the player
if (qualitySel) {
  qualitySel.onchange = async () => {
    if (!supportsQualityMenu) return;
    const map = { low:0, med:1, high:2 };
    const v = qualitySel.value; const spatialLayer = map[v];
    await new Promise(res => socket.emit('setPreferredLayers', { channelId, spatialLayer: (typeof spatialLayer === 'number' ? spatialLayer : 2) }, res));
  };
}

// ---- Fullscreen: request fullscreen on the CONTAINER so overlays can stay ----
const fsBtn = document.getElementById('fs');
if (fsBtn) {
  fsBtn.onclick = async () => {
    // prefer a wrapper with id="player" (position:relative; contains video + overlays)
    const container = document.getElementById('player') || el('remote');
    if (!document.fullscreenElement) await container.requestFullscreen().catch(()=>{});
    else await document.exitFullscreen().catch(()=>{});
  };
}
// Toggle a class on fullscreen to let CSS pin overlays correctly
document.addEventListener('fullscreenchange', () => {
  const container = document.getElementById('player');
  if (container) container.classList.toggle('is-fs', !!document.fullscreenElement);
});

// ------ AUTO‑PLAY on page load if channelId exists ------
document.addEventListener('DOMContentLoaded', () => {
  if (channelId) watch();
});

// (Optional) Expose a small API your friend’s app can call to change quality:
window.kohatViewer = {
  setQuality: async (level /* 'low' | 'med' | 'high' */) => {
    const map = { low:0, med:1, high:2 };
    if (!device || !recvTransport) return;
    await new Promise(res => socket.emit('setPreferredLayers', { channelId, spatialLayer: map[level] ?? 2 }, res));
  }
};
