// public/viewer.js
import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

(() => {
  'use strict';

  // ---- SAFETY SHIMS (Android WebView compat) ----
  (function () {
    function ensureCaps(v) {
      if (!v || typeof v !== 'object') return { codecs: [], headerExtensions: [] };
      if (!Array.isArray(v.codecs)) v.codecs = [];
      if (!Array.isArray(v.headerExtensions)) v.headerExtensions = [];
      return v;
    }
    if (window.RTCRtpReceiver && typeof RTCRtpReceiver.getCapabilities === 'function') {
      const orig = RTCRtpReceiver.getCapabilities.bind(RTCRtpReceiver);
      RTCRtpReceiver.getCapabilities = (kind) => {
        try { return ensureCaps(orig(kind)); } catch (_) { return ensureCaps(null); }
      };
    }
    if (window.RTCRtpSender && typeof RTCRtpSender.getCapabilities === 'function') {
      const orig = RTCRtpSender.getCapabilities.bind(RTCRtpSender);
      RTCRtpSender.getCapabilities = (kind) => {
        try { return ensureCaps(orig(kind)); } catch (_) { return ensureCaps(null); }
      };
    }
    if (window.MediaSource && typeof MediaSource.isTypeSupported === 'function') {
      const orig = MediaSource.isTypeSupported.bind(MediaSource);
      MediaSource.isTypeSupported = (type) => {
        try { return orig(type); } catch (_) { return false; }
      };
    }
  })();

  // ---- Helpers / UI ----
  const $ = (id) => document.getElementById(id);
  const toast = (msg, t = 1500) => {
    const el = $('toast'); if (!el) return;
    el.textContent = msg; el.style.display = 'block';
    setTimeout(() => (el.style.display = 'none'), t);
  };

  $('browse').onclick = () => location.href = '/lives.html';
  $('signout').onclick = () => { localStorage.clear(); location.replace('/signin.html'); };

  // Accept token from localStorage or ?token= and tolerate "Bearer "
  function getAuthToken() {
    const qs = new URLSearchParams(location.search);
    const fromQS = qs.get('token') || qs.get('authToken') || '';
    const fromLS = localStorage.getItem('token') || localStorage.getItem('authToken') || '';
    const raw = (fromLS || fromQS || '').trim();
    return raw.replace(/^Bearer\s+/i, ''); // mediasoup/Socket.IO want raw
  }

  const tokenRaw = getAuthToken();
  if (!tokenRaw) { location.replace('/signin.html'); return; }
  const tokenBearer = `Bearer ${tokenRaw}`; // keep Bearer form if your server expects it

  const statusEl = $('status');
  const badgeLive = $('live');
  const badgeVC = $('vc');
  const badgeRes = $('res');
  const badgeQ = $('quality');
  const skel = $('skel');
  const remote = $('remote');
  const qualitySel = $('qualitySel');

  // Make autoplay reliable in mobile/WebView
  try {
    remote.muted = true;
    remote.playsInline = true;
    remote.setAttribute('playsinline', '');
    remote.setAttribute('webkit-playsinline', '');
    remote.autoplay = true;
  } catch (_) {}

  const slug = new URLSearchParams(location.search).get('slug');
  if (!slug) {
    statusEl.textContent = '❌ Missing live slug. Please open from the Live List.';
    badgeLive.textContent = 'OFFLINE';
    badgeLive.className = 'badge';
    return;
  }

  // Use same-origin Socket.IO client; pass token (raw) in auth
  // Ensure your HTML includes: <script src="/socket.io/socket.io.js"></script>
  const socket = io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    auth: { role: 'viewer', token: tokenRaw, slug },
    withCredentials: true
  });

  socket.on('connect', () => { statusEl.textContent = '🔗 Connected'; });
  socket.on('disconnect', () => {
    statusEl.textContent = '❌ Disconnected';
    badgeLive.textContent = 'OFFLINE';
    badgeLive.className = 'badge';
  });
  socket.on('connect_error', (err) => {
    statusEl.textContent = `⚠️ Connect error: ${err?.message || err}`;
  });

  socket.on('viewers', (n) => (badgeVC.textContent = `👀 ${n}`));
  socket.on('newProducer', ({ kind }) => {
    toast(`${kind} stream updated`);
    if (kind === 'video') consumeVideo();
    if (kind === 'audio') consumeAudio();
  });

  let device, recvTransport, videoConsumer, audioConsumer;

  async function loadDevice() {
    if (device) return;
    const caps = await new Promise((res) => socket.emit('getRtpCapabilities', null, res));
    device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: caps });
  }

  async function ensureRecvTransport() {
    if (recvTransport) return;
    const params = await new Promise((res) => socket.emit('createRecvTransport', null, res));
    recvTransport = device.createRecvTransport(params);
    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) =>
      socket.emit('connectRecvTransport', { dtlsParameters }, (r) =>
        r?.error ? errback(new Error(r.error)) : callback()
      )
    );
  }

  async function consume(kind) {
    await loadDevice();
    await ensureRecvTransport();
    const params = await new Promise((res) =>
      socket.emit('consume', { kind, rtpCapabilities: device.rtpCapabilities }, res)
    );
    if (params?.error) throw new Error(params.error);
    const consumer = await recvTransport.consume(params);
    await socket.emit('resume', { consumerId: consumer.id }, () => {});
    return consumer;
  }

  async function consumeVideo() {
    try {
      skel.style.display = 'block';
      badgeLive.textContent = 'LIVE';
      badgeLive.className = 'badge live';
      const c = await consume('video');
      videoConsumer = c;
      const track = c.track;
      const stream = new MediaStream([track]);
      remote.srcObject = stream;
      // Play immediately if policy blocks it initially
      remote.play?.().catch(() => {});
      track.onended = () => {
        badgeLive.textContent = 'OFFLINE';
        badgeLive.className = 'badge';
        remote.srcObject = null;
      };
      skel.style.display = 'none';
      statusEl.textContent = '🎥 Video playing';
      updateResolutionBadge(c).catch(()=>{});
    } catch (err) {
      console.warn('video consume failed', err);
      skel.style.display = 'none';
      badgeLive.textContent = 'OFFLINE';
      badgeLive.className = 'badge';
      statusEl.textContent = '⚠️ Waiting for video…';
    }
  }

  async function consumeAudio() {
    try {
      const c = await consume('audio');
      audioConsumer = c;
      const track = c.track;
      const s = remote.srcObject || new MediaStream();
      s.addTrack(track);
      remote.srcObject = s;
      // Unmute video to hear audio once playing
      setTimeout(() => { try { remote.muted = false; } catch(_){} }, 300);
    } catch (err) {
      console.warn('audio consume failed', err);
    }
  }

  qualitySel.onchange = () => {
    const v = qualitySel.value;
    const pref = v === 'high' ? { spatialLayer: 2 }
               : v === 'med'  ? { spatialLayer: 1 }
               : v === 'low'  ? { spatialLayer: 0 }
               : { spatialLayer: 2 };
    socket.emit('setPreferredLayers', pref, () => { badgeQ.textContent = `Quality: ${v}`; });
  };

  async function updateResolutionBadge(consumer) {
    let lastLabel = '';
    setInterval(async () => {
      if (!consumer) return;
      const stats = await consumer.getStats();
      let w = 0, h = 0;
      stats.forEach(s => {
        if (s.type === 'inbound-rtp' && !s.isRemote) {
          if (typeof s.frameWidth === 'number')  w = s.frameWidth;
          if (typeof s.frameHeight === 'number') h = s.frameHeight;
        }
        if (s.type === 'track' && s.kind === 'video') {
          if (typeof s.frameWidth === 'number')  w = s.frameWidth || w;
          if (typeof s.frameHeight === 'number') h = s.frameHeight || h;
        }
      });
      if (h) {
        const label = `${h}p`;
        if (label !== lastLabel) { badgeRes.textContent = label; lastLabel = label; }
      }
    }, 2000);
  }

  consumeVideo().catch(() => { statusEl.textContent = '⚠️ Waiting for live stream…'; skel.style.display = 'block'; });
  consumeAudio().catch(() => {});
})();
