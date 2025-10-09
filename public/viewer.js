// public/viewer.js
import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

(() => {
  'use strict';

  // --------- DOM helpers ---------
  const $ = (id) => document.getElementById(id);
  const toast = (msg, t=1500) => {
    const el = $('toast'); if (!el) return;
    el.textContent = msg; el.style.display = 'block';
    setTimeout(() => (el.style.display = 'none'), t);
  };

  // Header actions
  $('browse').onclick = () => location.href = '/lives.html';
  $('signout').onclick = () => { localStorage.clear(); location.replace('/signin.html'); };

  // --------- Auth guard ---------
  const token = localStorage.getItem('token') || localStorage.getItem('authToken') || '';
  if (!token) { location.replace('/signin.html'); return; }

  // --------- UI refs ---------
  const statusEl = $('status');
  const badgeLive = $('live');
  const badgeVC = $('vc');
  const badgeRes = $('res');
  const badgeQ = $('quality');
  const skel = $('skel');
  const remote = $('remote');
  const qualitySel = $('qualitySel');

  // --------- Live slug from URL ---------
  const slug = new URLSearchParams(location.search).get('slug');
  if (!slug) {
    statusEl.textContent = '❌ Missing live slug. Please open from the Live List.';
    badgeLive.textContent = 'OFFLINE';
    badgeLive.className = 'badge';
    return;
  }

  // --------- Socket.IO connection ---------
  const socket = io({ auth: { role: 'viewer', token, slug } });
  socket.on('connect', () => { statusEl.textContent = '🔗 Connected'; });
  socket.on('disconnect', () => {
    statusEl.textContent = '❌ Disconnected';
    badgeLive.textContent = 'OFFLINE';
    badgeLive.className = 'badge';
  });
  socket.on('viewers', (n) => (badgeVC.textContent = `👀 ${n}`));
  socket.on('newProducer', ({ kind }) => {
    toast(`${kind} stream updated`);
    if (kind === 'video') consumeVideo();
    if (kind === 'audio') consumeAudio();
  });

  // --------- mediasoup state ---------
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
      track.onended = () => {
        badgeLive.textContent = 'OFFLINE';
        badgeLive.className = 'badge';
        remote.srcObject = null;
      };
      skel.style.display = 'none';
      statusEl.textContent = '🎥 Video playing';

      // Optional: update resolution badge periodically
      updateResolutionBadge(c).catch(()=>{});
    } catch (err) {
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
    } catch (err) {
      console.warn('audio consume failed', err);
    }
  }

  // --------- Quality control (simulcast layers) ---------
  qualitySel.onchange = () => {
    const v = qualitySel.value;
    const pref =
      v === 'high' ? { spatialLayer: 2 } :
      v === 'med'  ? { spatialLayer: 1 } :
      v === 'low'  ? { spatialLayer: 0 } :
                     { spatialLayer: 2 };
    socket.emit('setPreferredLayers', pref, () => {
      badgeQ.textContent = `Quality: ${v}`;
    });
  };

  // --------- Resolution badge from stats ---------
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
        if (label !== lastLabel) {
          badgeRes.textContent = label;
          lastLabel = label;
        }
      }
    }, 2000);
  }

  // --------- Start playback ---------
  consumeVideo().catch(() => {
    statusEl.textContent = '⚠️ Waiting for live stream…';
    skel.style.display = 'block';
  });
  consumeAudio().catch(() => {});
})();