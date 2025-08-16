// public/broadcaster.js
import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

const el = (id) => document.getElementById(id);
const toast = (t) => { const x = el('toast'); x.textContent = t; x.style.display='block'; setTimeout(()=>x.style.display='none', 1800); };
const setBadge = (on) => { const b = el('liveBadge'); b.textContent = on ? 'LIVE' : 'OFFLINE'; b.className = 'badge ' + (on ? 'live' : ''); };

// --- Channel: enforce ?ch=b1|b2 and set page title
function getChannelId() {
  const ch = new URLSearchParams(location.search).get('ch');
  if (!['b1','b2'].includes(ch)) { alert('Missing or invalid channel (?ch=b1|b2)'); throw new Error('bad channel'); }
  return ch;
}
const CHANNEL_ID = getChannelId();
document.title = (CHANNEL_ID === 'b1' ? 'Broadcaster 1' : 'Broadcaster 2') + ' • KoHat Live';

// --- Socket / mediasoup state
const socket = io();
let device, sendTransport, currentStream = null, videoProducer = null, audioProducer = null;
let startedAt = 0, upTimer = null;

// --- UI helpers
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
function stopStream(stream){
  if (!stream) return;
  for (const t of stream.getTracks()) { try{ t.stop(); }catch{} }
}

// --- mediasoup setup
async function loadDevice(){
  if (device) return;
  const caps = await new Promise(res => socket.emit('getRtpCapabilities', res));
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: caps });
}
async function ensureSendTransport(){
  if (sendTransport) return;
  const params = await new Promise(res => socket.emit('createSendTransport', { channelId: CHANNEL_ID }, res));
  if (params?.error) throw new Error(params.error);
  sendTransport = device.createSendTransport(params);
  sendTransport.on('connect', ({ dtlsParameters }, callback, errback) =>
    socket.emit('connectSendTransport', { channelId: CHANNEL_ID, dtlsParameters }, (r)=> r==='ok'?callback():errback(new Error('connect failed'))));
  sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) =>
    socket.emit('produce', { channelId: CHANNEL_ID, kind, rtpParameters }, (data)=> data?.error ? errback(new Error(data.error)) : callback({ id: data.id })));
}

// --- Simulcast encodings (q/h/f) so viewers can downshift quality
function pickEncodings() {
  return [
    { rid: 'q', maxBitrate: 150_000, scaleResolutionDownBy: 4 }, // ~360p
    { rid: 'h', maxBitrate: 600_000, scaleResolutionDownBy: 2 }, // ~540–720p
    { rid: 'f', maxBitrate: 1_500_000, scaleResolutionDownBy: 1 } // ~720–1080p
  ];
}

async function produceOrReplace(kind, track) {
  if (kind === 'video') {
    if (videoProducer) { await videoProducer.replaceTrack({ track }); return; }
    // Prefer H264 for Safari/iOS if supported; keep simulcast encodings.
    const h264 = device.rtpCapabilities.codecs.find(c => /video\/H264/i.test(c.mimeType));
    const opts = { track, encodings: pickEncodings() };
    if (h264) opts.codec = h264;
    videoProducer = await sendTransport.produce(opts);
  } else if (kind === 'audio') {
    if (!track) return;
    if (audioProducer) await audioProducer.replaceTrack({ track });
    else audioProducer = await sendTransport.produce({ track });
  }
}

// --- Swap between camera/screen sources while keeping the same producers
async function swapToStream(stream, label){
  el('local').srcObject = stream;

  await loadDevice();
  await ensureSendTransport();

  const v = stream.getVideoTracks()[0] || null;
  const a = stream.getAudioTracks()[0] || null;
  if (v) await produceOrReplace('video', v);
  if (a) await produceOrReplace('audio', a);

  if (currentStream && currentStream !== stream) stopStream(currentStream);
  currentStream = stream;

  setBadge(true);
  if (!startedAt) startUptime();

  // ✅ Clear loading state and update status consistently
  skeleton(false);
  el('status').textContent = (label === 'screen') ? '🖥️ Live (Screen)' : '📷 Live (Camera)';
  toast(label === 'screen' ? 'Screen sharing started' : 'Camera live');
}

// --- Actions
async function goLiveWithCamera(){
  el('status').textContent = 'Requesting camera/mic…';
  skeleton(true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    await swapToStream(stream, 'camera');
  } catch (e) {
    el('status').textContent = 'Failed: ' + (e?.message || e) + ' (HTTPS needed)';
    skeleton(false);
    throw e;
  }
}

async function shareScreen(){
  el('status').textContent = 'Requesting screen…';
  skeleton(true);
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const t = stream.getVideoTracks()[0];
    if (t) t.onended = async () => { toast('Screen share ended'); try { await goLiveWithCamera(); } catch {} };
    await swapToStream(stream, 'screen');
  } catch (e) {
    el('status').textContent = 'Failed: ' + (e?.message || e);
    skeleton(false);
    throw e;
  }
}

function stopBroadcast(){
  el('status').textContent='Stopping…';
  stopStream(currentStream);
  currentStream = null;
  el('local').srcObject = null;

  try{ videoProducer?.close(); }catch{}
  try{ audioProducer?.close(); }catch{}
  videoProducer=null; audioProducer=null;

  setBadge(false);
  startedAt=0; clearInterval(upTimer);
  el('uptime').textContent='00:00:00';

  // ✅ final state
  el('status').textContent = 'Stream stopped';
  toast('Stream stopped');
}

function toggleMic(){
  const track = currentStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled=!track.enabled;
  toast(track.enabled?'Mic unmuted':'Mic muted');
  el('toggleMic').textContent = track.enabled?'Mute Mic':'Unmute Mic';
}
function toggleCam(){
  const track = currentStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled=!track.enabled;
  toast(track.enabled?'Camera enabled':'Camera disabled');
  el('toggleCam').textContent = track.enabled?'Disable Cam':'Enable Cam';
}

// --- Join your channel's room so your viewer count updates for this channel
socket.emit('join', { channelId: CHANNEL_ID }, ()=>{});
socket.on('viewerCount', ({ count }) => { el('vc').textContent = `👀 ${count}`; });

// --- Connection toasts
socket.on('connect', () => toast('Connected'));
socket.io.on('reconnect_attempt', () => toast('Reconnecting…'));
socket.on('disconnect', () => toast('Disconnected'));

// --- Wire up buttons
el('go').onclick = () => goLiveWithCamera().catch(console.error);
el('share').onclick = () => shareScreen().catch(console.error);
el('stop').onclick = () => stopBroadcast();
el('toggleMic').onclick = () => toggleMic();
el('toggleCam').onclick = () => toggleCam();
el('end').onclick = () => stopBroadcast();
