// public/broadcast.js
import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

(() => {
  'use strict';

  // ---------- Shortcuts ----------
  const $  = (id) => document.getElementById(id);
  const qs = (s) => new URLSearchParams(location.search).get(s);

  const toast = (t, ms = 1600) => {
    const x = $('toast'); if (!x) return;
    x.textContent = t; x.style.display='block';
    setTimeout(()=>x.style.display='none', ms);
  };
  const setBadge = (on) => {
    const b = $('liveBadge');
    b.textContent = on ? 'LIVE' : 'OFFLINE';
    b.className = 'badge ' + (on ? 'live' : '');
  };
  const skel = (show) => { $('skel').style.display = show ? 'block' : 'none'; $('preview').style.display = show ? 'none' : 'block'; };

  // ---------- Auth guard & user ----------
  const token = localStorage.getItem('token') || localStorage.getItem('authToken') || '';
  if (!token) { location.replace('/signin.html'); return; }

  const user = JSON.parse(localStorage.getItem('user') || '{}');
  $('who').textContent = user.email || '';
  $('signout').onclick = () => { localStorage.clear(); location.replace('/signin.html'); };

  // ---------- Live identification ----------
  const liveId = qs('id') || null;
  const slug   = qs('slug') || null;
  if (!liveId && !slug) {
    alert('Missing live id/slug. Create a live from the Live List first.');
    location.replace('/lives.html');
    return;
  }

  // ---------- Socket.IO (auth handshake) ----------
  const socket = io({
    auth: { role: 'broadcaster', token, liveId, slug }
  });

  socket.on('connect', () => toast('Connected'));
  socket.io.on('reconnect_attempt', () => toast('Reconnecting…'));
  socket.on('disconnect', () => toast('Disconnected'));
  socket.on('viewers', (n) => { $('viewers').textContent = `👀 ${n}`; });

  // ---------- Mediasoup state ----------
  let device, sendTransport, currentStream = null, videoProducer = null, audioProducer = null;
  let startedAt = 0, upTimer = null;

  function startUptime(){
    startedAt = Date.now();
    if (upTimer) clearInterval(upTimer);
    upTimer = setInterval(()=>{
      const s = Math.floor((Date.now()-startedAt)/1000);
      const h = String(Math.floor(s/3600)).padStart(2,'0');
      const m = String(Math.floor((s%3600)/60)).padStart(2,'0');
      const sec = String(s%60).padStart(2,'0');
      $('uptime').textContent = `${h}:${m}:${sec}`;
    }, 1000);
  }
  function stopStream(stream){
    if (!stream) return;
    for (const t of stream.getTracks()) { try{ t.stop(); }catch{} }
  }

  async function loadDevice(){
    if (device) return;
    const caps = await new Promise(res => socket.emit('getRtpCapabilities', null, res));
    device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: caps });
  }
  async function ensureSendTransport(){
    if (sendTransport) return;
    const params = await new Promise(res => socket.emit('createSendTransport', null, res));
    if (params?.error) throw new Error(params.error);
    sendTransport = device.createSendTransport(params);
    sendTransport.on('connect', ({ dtlsParameters }, callback, errback) =>
      socket.emit('connectSendTransport', { dtlsParameters }, (r)=> r==='ok'?callback():errback(new Error('connect failed'))));
    sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) =>
      socket.emit('produce', { kind, rtpParameters }, (data)=> data?.error ? errback(new Error(data.error)) : callback({ id: data.id })));
  }

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

  // ---------- Camera enumeration & selection ----------
  const cameraSelect = $('cameraSelect');
  async function populateCameras() {
    if (!cameraSelect) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === 'videoinput');
      cameraSelect.innerHTML = '';
      cams.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Camera ${i+1}`;
        cameraSelect.appendChild(opt);
      });
      cameraSelect.style.display = cams.length > 1 ? 'inline-block' : 'none';
    } catch { cameraSelect.style.display = 'none'; }
  }

  // ---------- Source management ----------
  async function swapToStream(stream, label){
    $('preview').srcObject = stream;

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

    skel(false);
    $('status').textContent = (label === 'screen') ? '🖥️ Live (Screen)' : '📷 Live (Camera)';

    try {
      if (label !== 'screen') await populateCameras(); else cameraSelect.style.display = 'none';
    } catch {}
    toast(label === 'screen' ? 'Screen sharing started' : 'Camera live');
  }

  async function startCamera(){
    $('status').textContent = 'Requesting camera/mic…';
    skel(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      await swapToStream(stream, 'camera');
    } catch (e) {
      $('status').textContent = 'Failed: ' + (e?.message || e) + ' (HTTPS needed)';
      skel(false);
      console.error(e);
    }
  }

  async function startScreen(){
    $('status').textContent = 'Requesting screen…';
    skel(true);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const t = stream.getVideoTracks()[0];
      if (t) t.onended = async () => { toast('Screen share ended'); try { await startCamera(); } catch {} };
      await swapToStream(stream, 'screen');
    } catch (e) {
      $('status').textContent = 'Failed: ' + (e?.message || e);
      skel(false);
      console.error(e);
    }
  }

  // ---------- Buttons ----------
  $('btnStart').onclick  = () => startCamera();
  $('btnScreen').onclick = () => startScreen();

  $('btnCam').onclick = () => {
    const track = currentStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('btnCam').textContent = track.enabled ? 'Disable Cam' : 'Enable Cam';
    toast(track.enabled ? 'Camera enabled' : 'Camera disabled');
  };
  $('btnMic').onclick = () => {
    const track = currentStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('btnMic').textContent = track.enabled ? 'Mute Mic' : 'Unmute Mic';
    toast(track.enabled ? 'Mic unmuted' : 'Mic muted');
  };

  $('btnFlip').onclick = async () => {
    try {
      const current = currentStream?.getVideoTracks()[0];
      const facing = (current?.getSettings?.().facingMode === 'user') ? 'environment' : 'user';
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing } }, audio: true });
      await swapToStream(newStream, 'camera');
      $('status').textContent = `Camera flipped (${facing})`;
    } catch (err) { console.error(err); toast('Could not flip camera on this device'); }
  };

  $('btnEnd').onclick = () => $('endBtn').click();
  $('endBtn').onclick = async () => {
    if (!liveId) { location.replace('/lives.html'); return; }
    if (!confirm('End this live?')) return;
    try {
      const r = await fetch(`/api/lives/${encodeURIComponent(liveId)}/end`, {
        method: 'PATCH',
        headers: { 'Authorization': token }
      });
      try { videoProducer?.close(); } catch {}
      try { audioProducer?.close(); } catch {}
      stopStream(currentStream); currentStream = null; setBadge(false);
      if (!r.ok) {
        const j = await r.json().catch(()=>({}));
        throw new Error(j?.error || 'End live failed');
      }
      location.replace('/lives.html');
    } catch (e) {
      alert(e.message || 'Failed to end live');
    }
  };

  // Optionally auto-start:
  // startCamera().catch(()=>{});
})();