// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

// -------- Config --------
const PORT = process.env.PORT || 3000;
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '13.210.150.18';
const WEBRTC_MIN_PORT = 40000;
const WEBRTC_MAX_PORT = 49999;

// Admin accounts (env recommended)
const ACCOUNTS = {
  b1: { username: process.env.B1_USER || 'b1', password: process.env.B1_PASSWORD || 'changeme1', label: 'Broadcaster 1' },
  b2: { username: process.env.B2_USER || 'b2', password: process.env.B2_PASSWORD || 'changeme2', label: 'Broadcaster 2' },
};

// -------- App / Socket --------
const app = express();
app.use(express.urlencoded({ extended: false })); // for login POST
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Static files
app.use(express.static('public'));

// Simple cookie helpers
function parseCookie(header = '') {
  return Object.fromEntries(
    header.split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(kv => kv[0])
  );
}
function setCookie(res, name, value) {
  const cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7200`;
  res.setHeader('Set-Cookie', cookie);
}

// -------- Mediasoup core --------
let worker, router;
const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  // Keep VP8 and H264. We will PRODUCE H264 by default for Safari compatibility.
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  {
    kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'level-asymmetry-allowed': 1, 'packetization-mode': 1, 'profile-level-id': '42e01f' }
  }
];

// Per‑channel state
const CHANNEL_IDS = ['b1', 'b2'];
const channels = new Map(); // id -> { videoProducer, audioProducer }
for (const id of CHANNEL_IDS) channels.set(id, { videoProducer: null, audioProducer: null });

function roomName(id) { return `ch:${id}`; }

(async () => {
  worker = await mediasoup.createWorker({ rtcMinPort: WEBRTC_MIN_PORT, rtcMaxPort: WEBRTC_MAX_PORT });
  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2s...');
    setTimeout(() => process.exit(1), 2000);
  });
  router = await worker.createRouter({ mediaCodecs });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
    console.log(`ANNOUNCED_IP = ${ANNOUNCED_IP}`);
  });
})();

async function createWebRtcTransport() {
  return router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
    enableUdp: true, enableTcp: true, preferUdp: true
  });
}

function broadcastViewerCount(channelId) {
  const rn = roomName(channelId);
  const count = io.sockets.adapter.rooms.get(rn)?.size || 0;
  io.to(rn).emit('viewerCount', { count });
}

// --------- Login & guard (you already have public/login.html) ---------
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const entry = Object.values(ACCOUNTS).find(a => a.username === username);
  if (!entry || password !== entry.password) return res.redirect('/login?err=1');
  const channelId = entry.username; // 'b1' or 'b2'
  setCookie(res, 'host', channelId);
  return res.redirect(`/broadcaster.html?ch=${channelId}`);
});

// Protect /broadcaster.html so a host can only access their channel
app.get('/broadcaster.html', (req, res) => {
  const cookies = parseCookie(req.headers.cookie || '');
  const host = cookies.host;
  const url = new URL(`${req.protocol}://${req.headers.host}${req.url}`);
  const ch = url.searchParams.get('ch');
  if (!host || !CHANNEL_IDS.includes(host)) return res.redirect('/login');
  if (!ch || ch !== host) return res.redirect(`/broadcaster.html?ch=${host}`);
  res.sendFile(path.join(__dirname, 'public', 'broadcaster.html'));
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  // helpers
  const askCh = (payload) => CHANNEL_IDS.includes(payload?.channelId) ? payload.channelId : null;
  const assertHostFor = (channelId) => {
    const cookies = parseCookie(socket.request.headers.cookie || '');
    if (!cookies.host || cookies.host !== channelId) throw new Error('not authorized for this channel');
  };

  // join/leave for viewer count
  socket.on('join', ({ channelId } = {}, cb = () => {}) => {
    const ch = askCh({ channelId }); if (!ch) return cb({ error: 'invalid channelId' });
    socket.join(roomName(ch)); broadcastViewerCount(ch); cb('ok');
  });
  socket.on('leave', ({ channelId } = {}, cb = () => {}) => {
    const ch = askCh({ channelId }); if (!ch) return cb({ error: 'invalid channelId' });
    socket.leave(roomName(ch)); broadcastViewerCount(ch); cb('ok');
  });

  socket.on('getRtpCapabilities', (cb) => cb(router.rtpCapabilities));

  // ---- Broadcaster (send) ----
  socket.on('createSendTransport', async ({ channelId } = {}, cb) => {
    try {
      const ch = askCh({ channelId }); assertHostFor(ch);
      const t = await createWebRtcTransport();
      socket.data[`sendTransport_${ch}`] = t;
      cb({ id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters });
    } catch (err) { console.error('createSendTransport', err.message); cb({ error: err.message }); }
  });

  socket.on('connectSendTransport', async ({ channelId, dtlsParameters }, cb) => {
    try { const ch = askCh({ channelId }); assertHostFor(ch); await socket.data[`sendTransport_${ch}`].connect({ dtlsParameters }); cb('ok'); }
    catch (err) { console.error('connectSendTransport', err.message); cb({ error: err.message }); }
  });

  socket.on('produce', async ({ channelId, kind, rtpParameters }, cb) => {
    try {
      const ch = askCh({ channelId }); assertHostFor(ch);
      const t = socket.data[`sendTransport_${ch}`]; if (!t) return cb({ error: 'no send transport' });
      const producer = await t.produce({ kind, rtpParameters });

      const state = channels.get(ch);
      if (kind === 'video') {
        try { await state.videoProducer?.close(); } catch {}
        state.videoProducer = producer;
        io.to(roomName(ch)).emit('newProducer', { channelId: ch, kind: 'video' });
      } else {
        try { await state.audioProducer?.close(); } catch {}
        state.audioProducer = producer;
        io.to(roomName(ch)).emit('newProducer', { channelId: ch, kind: 'audio' });
      }

      producer.on('transportclose', () => console.log(`[${ch}] ${kind} producer transport closed`));
      producer.on('close', () => console.log(`[${ch}] ${kind} producer closed`));
      cb({ id: producer.id });
    } catch (err) { console.error('produce', err.message); cb({ error: err.message }); }
  });

  // ---- Viewer (recv) ----
  socket.on('createRecvTransport', async ({ channelId } = {}, cb) => {
    try {
      const ch = askCh({ channelId }); if (!ch) return cb({ error: 'invalid channelId' });
      const t = await createWebRtcTransport();
      socket.data[`recvTransport_${ch}`] = t;
      cb({ id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters });
    } catch (err) { console.error('createRecvTransport', err.message); cb({ error: err.message }); }
  });

  socket.on('connectRecvTransport', async ({ channelId, dtlsParameters }, cb) => {
    try {
      const ch = askCh({ channelId }); await socket.data[`recvTransport_${ch}`].connect({ dtlsParameters }); cb('ok');
    } catch (err) { console.error('connectRecvTransport', err.message); cb({ error: err.message }); }
  });

  socket.on('consume', async ({ channelId, rtpCapabilities, kind }, cb) => {
    try {
      const ch = askCh({ channelId }); if (!ch) return cb({ error: 'invalid channelId' });
      const state = channels.get(ch);
      const target = kind === 'video' ? state.videoProducer : state.audioProducer;
      if (!target) return cb({ error: `no ${kind} producer` });
      if (!router.canConsume({ producerId: target.id, rtpCapabilities })) return cb({ error: 'cannot consume' });

      const t = socket.data[`recvTransport_${ch}`];
      const consumer = await t.consume({ producerId: target.id, rtpCapabilities, paused: true });

      // store consumers
      const list = socket.data.consumers || []; list.push(consumer); socket.data.consumers = list;
      if (consumer.kind === 'video') socket.data[`videoConsumer_${ch}`] = consumer;

      consumer.on('transportclose', () => console.log(`[${ch}] ${kind} consumer transport closed`));
      consumer.on('producerclose', () => console.log(`[${ch}] ${kind} producer closed -> consumer will be replaced`));

      cb({ id: consumer.id, producerId: target.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
    } catch (err) { console.error('consume', err.message); cb({ error: err.message }); }
  });

  socket.on('resume', async ({ consumerId }, cb) => {
    const list = socket.data.consumers || [];
    const c = list.find(x => x.id === consumerId);
    if (c) await c.resume();
    cb('ok');
  });

  // Allow client to change quality layer (for simulcast/SVC)
  socket.on('setPreferredLayers', async ({ channelId, spatialLayer = 2, temporalLayer = null }, cb = () => {}) => {
    try {
      const ch = askCh({ channelId }); if (!ch) return cb({ error: 'invalid channelId' });
      const c = socket.data[`videoConsumer_${ch}`];
      if (!c) return cb({ error: 'no video consumer yet' });
      await c.setPreferredLayers({ spatialLayer, temporalLayer });
      cb('ok');
    } catch (e) { cb({ error: e.message }); }
  });

  // disconnect cleanup
  socket.on('disconnect', () => {
    for (const ch of CHANNEL_IDS) {
      try { socket.leave(roomName(ch)); } catch {}
      try { socket.data[`sendTransport_${ch}`]?.close(); } catch {}
      try { socket.data[`recvTransport_${ch}`]?.close(); } catch {}
      broadcastViewerCount(ch);
    }
    const list = socket.data.consumers || [];
    for (const c of list) { try { c.close(); } catch {} }
  });
});
