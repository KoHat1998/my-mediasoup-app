import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

const el = (id) => document.getElementById(id);
const toast = (t) => { const x = el('toast'); x.textContent = t; x.style.display='block'; setTimeout(()=>x.style.display='none', 1800); };
const setBadge = (on) => {
  const b = el('liveBadge');
  b.textContent = on ? 'LIVE' : 'OFFLINE';
  b.className = 'badge ' + (on ? 'live' : '');
};

const socket = io();
let device, sendTransport;
let currentStream = null;
let videoProducer = null;
let audioProducer = null;
let startedAt = 0, upTimer = null;

function skeleton(show){
  el('skel').style.display = show ? 'block' : 'none';
  el('local').style.display = show ? 'none' : 'block';
}

function startUptime(){
  startedAt = Date.now();
  if (upTimer) clearInterval(upTimer);
  upTimer = setInterval(()=>{
    const s = Math.floor((Date.now()-startedAt)/1000);
    const h = String(Math.floor(s/3600)).padStart(2,'0');
    const m = String(Math.floor((s%3600)/60)).padStart(2,'0');
    const sec = String(s%60).padStart(2,'0');
    el('uptime').textContent = `${h}:${m}:${sec}`;
  }, 1000);
}

async function loadDevice() {
  if (device) return;
  const rtpCapabilities = await new Promise(res => socket.emit('getRtpCapabilities', res));
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });
}

async function ensureSendTransport() {
  if (sendTransport) return;
  const params = await new Promise(res => socket.emit('createSendTransport', res));
  if (params?.error) throw new Error(params.error);

  sendTransport = device.createSendTransport({
    id: params.id,
    iceParameters: params.iceParameters,
    iceCandidates: params.iceCandidates,
    dtlsParameters: params.dtlsParameters,
  });

  sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.emit('connectSendTransport', { dtlsParameters }, (r) => r === 'ok' ? callback() : errback(new Error('connect failed')));
  });
  sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
    socket.emit('produce', { kind, rtpParameters }, (data) => data?.error ? errback(new Error(data.error)) : callback({ id: data.id }));
  });
}

function stopStream(stream){ if (!stream) return; for (const t of stream.getTracks()) { try{ t.stop(); }catch{} } }

async function produceOrReplace(kind, track) {
  if (kind === 'video') {
    if (videoProducer) await videoProducer.replaceTrack({ track });
    else videoProducer = await sendTransport.produce({ track });
  } else if (kind === 'audio') {
    if (!track) return;
    if (audioProducer) await audioProducer.replaceTrack({ track });
    else audioProducer = await sendTransport.produce({ track });
  }
}

async function swapToStream(stream, label) {
  el('local').srcObject = stream;
  await loadDevice(); await ensureSendTransport();

  const v = stream.getVideoTracks()[0] || null;
  const a = stream.getAudioTracks()[0] || null;
  if (v) await produceOrReplace('video', v);
  if (a) await produceOrReplace('audio', a);

  if (currentStream && currentStream !== stream) stopStream(currentStream);
  currentStream = stream;

  setBadge(true);
  if (!startedAt) startUptime();
  toast(label === 'screen' ? 'Screen sharing started' : 'Camera live');
}

async function goLiveWithCamera() {
  el('status').textContent = 'Requesting camera/mic…';
  skeleton(true);
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(e => {
    el('status').textContent = 'Failed to get camera/mic: ' + e.message + ' (use HTTPS)'; throw e;
  });
  skeleton(false);
  await swapToStream(stream, 'camera');
}

async function shareScreen() {
  el('status').textContent = 'Requesting screen…';
  skeleton(true);
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).catch(e => {
    el('status').textContent = 'Failed to share screen: ' + e.message; throw e;
  });
  const screenVideo = stream.getVideoTracks()[0];
  if (screenVideo) {
    screenVideo.onended = async () => { toast('Screen share ended'); try { await goLiveWithCamera(); } catch {} };
  }
  skeleton(false);
  await swapToStream(stream, 'screen');
}

function stopBroadcast() {
  el('status').textContent = 'Stopping…';
  stopStream(currentStream); currentStream = null; el('local').srcObject = null;
  try { videoProducer?.close(); } catch {}
  try { audioProducer?.close(); } catch {}
  videoProducer = null; audioProducer = null;
  setBadge(false); startedAt = 0; clearInterval(upTimer); el('uptime').textContent = '00:00:00';
  toast('Stream stopped');
}

function toggleMic(){
  const track = currentStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  toast(track.enabled ? 'Mic unmuted' : 'Mic muted');
  el('toggleMic').textContent = track.enabled ? 'Mute Mic' : 'Unmute Mic';
}

function toggleCam(){
  const track = currentStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  toast(track.enabled ? 'Camera enabled' : 'Camera disabled');
  el('toggleCam').textContent = track.enabled ? 'Disable Cam' : 'Enable Cam';
}

// Viewer count
socket.on('viewerCount', ({ count }) => { el('vc').textContent = `👀 ${count}`; });

// Connection toasts
socket.on('connect', () => toast('Connected'));
socket.io.on('reconnect_attempt', () => toast('Reconnecting…'));
socket.on('disconnect', () => toast('Disconnected'));

el('go').onclick = () => goLiveWithCamera().catch(console.error);
el('share').onclick = () => shareScreen().catch(console.error);
el('stop').onclick = () => stopBroadcast();
el('toggleMic').onclick = () => toggleMic();
el('toggleCam').onclick = () => toggleCam();
el('end').onclick = () => stopBroadcast();
