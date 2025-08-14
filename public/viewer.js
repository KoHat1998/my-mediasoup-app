import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

const el = (id) => document.getElementById(id);
const toast = (t) => { const x = el('toast'); x.textContent = t; x.style.display='block'; setTimeout(()=>x.style.display='none', 1800); };

function getChannelId() {
  const ch = new URLSearchParams(location.search).get('ch');
  if (!['b1','b2'].includes(ch)) return null;
  return ch;
}
const channelId = getChannelId();
if (channelId) document.title = (channelId === 'b1' ? 'Broadcaster 1' : 'Broadcaster 2') + ' • Watch';

const socket = io();
let device, recvTransport;
const mediaStream = new MediaStream();
let videoConsumer = null, audioConsumer = null;

let statsTimer = null, lastBytes = 0, lastTs = 0;

function skeleton(show){ el('skel').style.display = show ? 'block' : 'none'; el('remote').style.display = show ? 'none' : 'block'; }

function setQualityBadge(kbps, plr){
  const q = el('quality'); let cls = 'badge quality '; let txt = `~${Math.round(kbps)} kbps`;
  if (plr >= 5 || kbps < 200) { cls += 'bad'; txt += ' • Poor'; }
  else if (plr >= 2 || kbps < 600) { cls += 'warn'; txt += ' • Fair'; }
  else { cls += 'ok'; txt += ' • Good'; }
  q.className = cls; q.textContent = txt;
}

async function loadDevice(){ const caps = await new Promise(res => socket.emit('getRtpCapabilities', res)); const d = new mediasoupClient.Device(); await d.load({ routerRtpCapabilities: caps }); return d; }

async function createRecvTransport() {
  const params = await new Promise(res => socket.emit('createRecvTransport', { channelId }, res));
  if (params?.error) throw new Error(params.error);
  const t = new mediasoupClient.Transport('recv', params); // not public API; use helper:
  // Use client helper instead:
  const recv = new mediasoupClient.Device().createRecvTransport; // ignore; we’ll do standard way below
}

// Standard way:
async function makeRecvTransport() {
  const params = await new Promise(res => socket.emit('createRecvTransport', { channelId }, res));
  if (params?.error) throw new Error(params.error);
  const t = device.createRecvTransport(params);
  t.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.emit('connectRecvTransport', { channelId, dtlsParameters }, (r) => r === 'ok' ? callback() : errback(new Error('connect failed')));
  });
  return t;
}

function attachTrack(kind, track){
  if (kind === 'video') { const old = mediaStream.getVideoTracks()[0]; if (old) mediaStream.removeTrack(old); mediaStream.addTrack(track); }
  else { const old = mediaStream.getAudioTracks()[0]; if (old) mediaStream.removeTrack(old); mediaStream.addTrack(track); }
  if (!el('remote').srcObject) el('remote').srcObject = mediaStream;
}

async function consumeKind(kind) {
  const data = await new Promise(res => socket.emit('consume', { channelId, rtpCapabilities: device.rtpCapabilities, kind }, res));
  if (data?.error) { if (kind === 'video') el('live').textContent = 'Waiting for broadcaster…'; return null; }
  const consumer = await recvTransport.consume(data);
  attachTrack(kind, consumer.track);
  await new Promise(res => socket.emit('resume', { consumerId: consumer.id }, res));
  consumer.on('producerclose', async () => { try { await reconsume(kind); } catch(e){ console.error(e); } });
  if (kind === 'video') el('res').textContent = '720p';
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
  if (!channelId) { el('status').textContent = 'Pick a channel first'; return; }
  try {
    el('status').textContent = 'Connecting…'; skeleton(true);
    socket.emit('join', { channelId }, ()=>{});
    device = new mediasoupClient.Device(); await device.load({ routerRtpCapabilities: await new Promise(res => socket.emit('getRtpCapabilities', res)) });
    recvTransport = await makeRecvTransport();
    videoConsumer = await consumeKind('video');
    audioConsumer = await consumeKind('audio');
    if (videoConsumer) { el('live').textContent = 'LIVE'; skeleton(false); startStats(); }
    else { el('live').textContent = 'Waiting for broadcaster…'; }
    el('status').textContent = '📺 Watching';
  } catch (e) { console.error(e); el('status').textContent = e.message || 'Error starting viewer'; }
}

socket.on('newProducer', async ({ channelId: cid, kind }) => {
  if (cid !== channelId || !device || !recvTransport) return;
  try { await reconsume(kind); } catch(e){ console.error(e); }
});

socket.on('viewerCount', ({ count }) => { el('vc').textContent = `👀 ${count}`; });
socket.on('connect', () => toast('Connected'));
socket.io.on('reconnect_attempt', () => toast('Reconnecting…'));
socket.on('disconnect', () => toast('Disconnected'));

el('watch').onclick = watch;
el('fs').onclick = async () => { const v = el('remote'); if (!document.fullscreenElement) await v.requestFullscreen().catch(()=>{}); else await document.exitFullscreen().catch(()=>{}); };
el('pip').onclick = async () => { const v = el('remote'); if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(()=>{}); else if (document.pictureInPictureEnabled) await v.requestPictureInPicture().catch(()=>{}); };
