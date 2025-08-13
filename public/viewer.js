import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

const el = (id) => document.getElementById(id);
const toast = (t) => { const x = el('toast'); x.textContent = t; x.style.display='block'; setTimeout(()=>x.style.display='none', 1800); };

const socket = io();
let device, recvTransport;
const mediaStream = new MediaStream();
let videoConsumer = null, audioConsumer = null;

let statsTimer = null;
let lastBytes = 0, lastTs = 0;

function skeleton(show){
  el('skel').style.display = show ? 'block' : 'none';
  el('remote').style.display = show ? 'none' : 'block';
}

function setQualityBadge(kbps, plr){ // plr: packet loss ratio %
  const q = el('quality');
  let cls = 'badge quality ';
  let txt = `~${Math.round(kbps)} kbps`;
  if (plr >= 5 || kbps < 200) { cls += 'bad'; txt += ' • Poor'; }
  else if (plr >= 2 || kbps < 600) { cls += 'warn'; txt += ' • Fair'; }
  else { cls += 'ok'; txt += ' • Good'; }
  q.className = cls; q.textContent = txt;
}

async function loadDevice() {
  const rtpCapabilities = await new Promise(res => socket.emit('getRtpCapabilities', res));
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });
}

async function createRecvTransport() {
  const params = await new Promise(res => socket.emit('createRecvTransport', res));
  if (params?.error) throw new Error(params.error);
  recvTransport = device.createRecvTransport({
    id: params.id,
    iceParameters: params.iceParameters,
    iceCandidates: params.iceCandidates,
    dtlsParameters: params.dtlsParameters
  });
  recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.emit('connectRecvTransport', { dtlsParameters }, (r) => r === 'ok' ? callback() : errback(new Error('connect failed')));
  });
}

function attachTrack(kind, track){
  if (kind === 'video') {
    const old = mediaStream.getVideoTracks()[0]; if (old) mediaStream.removeTrack(old);
    mediaStream.addTrack(track);
  } else {
    const old = mediaStream.getAudioTracks()[0]; if (old) mediaStream.removeTrack(old);
    mediaStream.addTrack(track);
  }
  if (!el('remote').srcObject) el('remote').srcObject = mediaStream;
}

async function consumeKind(kind) {
  const data = await new Promise(res => socket.emit('consume', { rtpCapabilities: device.rtpCapabilities, kind }, res));
  if (data?.error) {
    if (kind === 'video') { el('live').textContent = 'Waiting for broadcaster…'; }
    return null;
  }
  const consumer = await recvTransport.consume(data);
  attachTrack(kind, consumer.track);
  await new Promise(res => socket.emit('resume', { consumerId: consumer.id }, res));

  consumer.on('producerclose', async () => { // producer replaced on host side
    try { await reconsume(kind); } catch(e) { console.error(e); }
  });

  if (kind === 'video') {
    // Set resolution badge
    const s = el('remote').getVideoPlaybackQuality?.();
    el('res').textContent = '720p';
  }

  return consumer;
}

async function reconsume(kind){
  const data = await new Promise(res => socket.emit('consume', { rtpCapabilities: device.rtpCapabilities, kind }, res));
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
    stats.forEach(s => {
      if (s.type === 'inbound-rtp' && !s.isRemote) {
        bytes = s.bytesReceived; timestamp = s.timestamp;
        pl = s.packetsLost || 0; pr = s.packetsReceived || 0;
      }
    });
    if (lastTs && timestamp && bytes >= lastBytes) {
      const kbps = ((bytes - lastBytes) * 8) / ((timestamp - lastTs) / 1000) / 1000;
      const plr = pr > 0 ? (pl / (pr + pl)) * 100 : 0;
      setQualityBadge(kbps, plr);
    }
    lastBytes = bytes; lastTs = timestamp;
  }, 3000);
}

async function watch() {
  try {
    el('status').textContent = 'Connecting…'; skeleton(true);
    socket.emit('join'); // join room for viewer count
    await loadDevice();
    await createRecvTransport();
    videoConsumer = await consumeKind('video');
    audioConsumer = await consumeKind('audio');

    if (videoConsumer) {
      el('live').textContent = 'LIVE';
      skeleton(false);
      startStats();
    } else {
      el('live').textContent = 'Waiting for broadcaster…';
    }
    el('status').textContent = '📺 Watching';
  } catch (e) {
    console.error(e);
    el('status').textContent = e.message || 'Error starting viewer';
  }
}

// Faster update when server announces a new producer
socket.on('newProducer', async ({ kind }) => {
  if (!device || !recvTransport) return;
  try { await reconsume(kind); } catch(e){ console.error(e); }
});

// Viewer count + connection toasts
socket.on('viewerCount', ({ count }) => { el('vc').textContent = `👀 ${count}`; });
socket.on('connect', () => toast('Connected'));
socket.io.on('reconnect_attempt', () => toast('Reconnecting…'));
socket.on('disconnect', () => toast('Disconnected'));

el('watch').onclick = watch;

el('fs').onclick = async () => {
  const v = el('remote');
  if (!document.fullscreenElement) await v.requestFullscreen().catch(()=>{});
  else await document.exitFullscreen().catch(()=>{});
};
el('pip').onclick = async () => {
  const v = el('remote');
  if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(()=>{});
  else if (document.pictureInPictureEnabled) await v.requestPictureInPicture().catch(()=>{});
};
