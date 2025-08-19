// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

// -------- Config --------
const PORT = process.env.PORT || 3000;
// IMPORTANT: set to your EC2 public/elastic IP (or pass ANNOUNCED_IP via env for PM2)
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '13.210.150.18';
const WEBRTC_MIN_PORT = 40000;
const WEBRTC_MAX_PORT = 49999;

// Admin accounts (env recommended)
const ACCOUNTS = {
  b1: {
    username: process.env.B1_USER || 'b1',
    password: process.env.B1_PASSWORD || 'changeme1',
    label: 'Broadcaster 1',
  },
  b2: {
    username: process.env.B2_USER || 'b2',
    password: process.env.B2_PASSWORD || 'changeme2',
    label: 'Broadcaster 2',
  }
};

// -------- App / Socket --------
const app = express();
app.use(express.urlencoded({ extended: false })); // for login POST
// serve static *after* special routes (so we can protect /broadcaster.html)
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// -------- Helpers (cookies / proto) --------
function parseCookie(header = '') {
  return Object.fromEntries(
    header.split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(kv => kv[0])
  );
}
function isHttps(req) {
  // honor reverse proxy headers
  return (req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' || req.secure;
}
function setCookie(req, res, name, value) {
  // 2h session cookie; Secure only when HTTPS (so local HTTP dev still works)
  const parts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=7200'
  ];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// -------- Mediasoup core --------
let worker, router;
const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'level-asymmetry-allowed': 1, 'packetization-mode': 1, 'profile-level-id': '42e01f' } }
];

// Per-channel state
const CHANNEL_IDS = ['b1', 'b2'];
const channels = new Map(); // id -> { videoProducer, audioProducer }
for (const id of CHANNEL_IDS) channels.set(id, { videoProducer: null, audioProducer: null });

const consumers = new Map(); // socket.id -> Consumer[]
function roomName(id) { return `ch:${id}`; }

(async () => {
  worker = await mediasoup.createWorker({ rtcMinPort: WEBRTC_MIN_PORT, rtcMaxPort: WEBRTC_MAX_PORT });
  worker.on('died', () => {
    console.error('💥 mediasoup worker died, exiting in 2s...');
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

/**
 * Broadcast viewer count excluding any host socket(s).
 */
function broadcastViewerCount(channelId) {
  const rn = roomName(channelId);
  const members = io.sockets.adapter.rooms.get(rn) || new Set();

  let count = 0;
  for (const sid of members) {
    const s = io.sockets.sockets.get(sid);
    if (!s?.data?.isHostFor || s.data.isHostFor !== channelId) count++;
  }
  io.to(rn).emit('viewerCount', { count });
}

// --------- Auth pages / routes ---------

// Login page
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login submit
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const entry = Object.values(ACCOUNTS).find(a => a.username === username);
  if (!entry || password !== entry.password) {
    return res.redirect('/login?err=1');
  }
  const channelId = entry.username; // 'b1' or 'b2'
  setCookie(req, res, 'host', channelId);
  return res.redirect(`/broadcaster.html?ch=${channelId}`);
});

// Protect the broadcaster page (must have host cookie and it must match ?ch=)
app.get('/broadcaster.html', (req, res) => {
  const cookies = parseCookie(req.headers.cookie || '');
  const host = cookies.host;

  // Build URL with proxy-aware proto
  const proto = (req.headers['x-forwarded-proto'] || req.protocol);
  const url = new URL(`${proto}://${req.headers.host}${req.url}`);
  const ch = url.searchParams.get('ch');

  if (!host || !CHANNEL_IDS.includes(host)) {
    return res.redirect('/login');
  }
  if (!ch || ch !== host) {
    // force your own channel if someone tries the other one
    return res.redirect(`/broadcaster.html?ch=${host}`);
  }

  // never cache protected page
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'broadcaster.html'));
});

// Guard: if someone tries to fetch the raw file under /public (e.g. via proxy misconfig), deny it.
app.get(['/public/broadcaster.html', '/public/broadcaster'], (_req, res) => {
  return res.status(404).send('Not found');
});

// Everyone else static (after protected routes)
app.use(express.static('public', {
  setHeaders(res, filepath) {
    if (filepath.endsWith(path.sep + 'broadcaster.html')) {
      // belt & suspenders: do not cache even if served through our guarded route
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  // Helper: safe cb
  const ok = (cb, payload='ok') => { try { (cb||(()=>{}))(payload);} catch(e) { console.error('ack error', e); } };
  const errAck = (cb, message) => ok(cb, { error: message });

  // Which channel is this user *trying* to act on?
  function getChannelIdFromPayload(payload) {
    const cid = payload?.channelId;
    return CHANNEL_IDS.includes(cid) ? cid : null;
  }
  // For producers: check the cookie host === channelId
  function assertIsChannelHost(channelId) {
    const cookies = parseCookie(socket.request.headers.cookie || '');
    const host = cookies.host;
    if (!host || host !== channelId) throw new Error('not authorized for this channel');
  }

  /**
   * Tag sockets when they join to indicate if they are the host for that channel.
   */
  socket.on('join', ({ channelId } = {}, cb) => {
    const ch = getChannelIdFromPayload({ channelId });
    if (!ch) return errAck(cb, 'invalid channelId');

    try {
      const cookies = parseCookie(socket.request.headers.cookie || '');
      socket.data.isHostFor = (cookies.host === ch) ? ch : null;
    } catch {
      socket.data.isHostFor = null;
    }

    socket.join(roomName(ch));
    broadcastViewerCount(ch);
    ok(cb);
  });

  socket.on('leave', ({ channelId } = {}, cb) => {
    const ch = getChannelIdFromPayload({ channelId });
    if (!ch) return errAck(cb, 'invalid channelId');
    socket.leave(roomName(ch));
    broadcastViewerCount(ch);
    ok(cb);
  });

  socket.on('getRtpCapabilities', (cb) => ok(cb, router.rtpCapabilities));

  // ---- Broadcaster (send) ----
  socket.on('createSendTransport', async ({ channelId } = {}, cb) => {
    try {
      const ch = getChannelIdFromPayload({ channelId });
      assertIsChannelHost(ch);
      const transport = await createWebRtcTransport();
      socket.data[`sendTransport_${ch}`] = transport;

      // If the transport dies, clear producers for this channel
      transport.on('close', () => {
        try {
          const state = channels.get(ch);
        if (state) {
            state.videoProducer = null;
            state.audioProducer = null;
          }
        } catch {}
      });

      ok(cb, {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
    } catch (e) {
      console.error('createSendTransport error', e);
      errAck(cb, e.message || 'createSendTransport failed');
    }
  });

  socket.on('connectSendTransport', async ({ channelId, dtlsParameters }, cb) => {
    try {
      const ch = getChannelIdFromPayload({ channelId });
      assertIsChannelHost(ch);
      const t = socket.data[`sendTransport_${ch}`];
      if (!t) return errAck(cb, 'no send transport');
      await t.connect({ dtlsParameters });
      ok(cb);
    } catch (e) {
      console.error('connectSendTransport error', e);
      errAck(cb, e.message || 'connectSendTransport failed');
    }
  });

  socket.on('produce', async ({ channelId, kind, rtpParameters }, cb) => {
    try {
      const ch = getChannelIdFromPayload({ channelId });
      assertIsChannelHost(ch);
      const t = socket.data[`sendTransport_${ch}`];
      if (!t) return errAck(cb, 'no send transport');

      const producer = await t.produce({ kind, rtpParameters });
      const state = channels.get(ch);

      // replace existing producer of same kind
      if (kind === 'video') {
        try { await state.videoProducer?.close(); } catch {}
        state.videoProducer = producer;
        io.to(roomName(ch)).emit('newProducer', { channelId: ch, kind: 'video' });
      } else if (kind === 'audio') {
        try { await state.audioProducer?.close(); } catch {}
        state.audioProducer = producer;
        io.to(roomName(ch)).emit('newProducer', { channelId: ch, kind: 'audio' });
      }

      producer.on('transportclose', () => {
        console.log(`[${ch}] ${kind} producer transport closed`);
        // ensure state is cleared so future consume doesn't use stale id
        try {
          const s = channels.get(ch);
          if (!s) return;
          if (kind === 'video') s.videoProducer = null;
          else s.audioProducer = null;
        } catch {}
      });
      producer.on('close', () => {
        console.log(`[${ch}] ${kind} producer closed`);
        try {
          const s = channels.get(ch);
          if (!s) return;
          if (kind === 'video') s.videoProducer = null;
          else s.audioProducer = null;
        } catch {}
      });

      ok(cb, { id: producer.id });
    } catch (e) {
      console.error('produce error', e);
      errAck(cb, e.message || 'produce failed');
    }
  });

  // ---- Viewer (recv) ----
  socket.on('createRecvTransport', async ({ channelId } = {}, cb) => {
    try {
      const ch = getChannelIdFromPayload({ channelId });
      if (!ch) return errAck(cb, 'invalid channelId');
      const transport = await createWebRtcTransport();
      socket.data[`recvTransport_${ch}`] = transport;

      ok(cb, {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
    } catch (e) {
      console.error('createRecvTransport error', e);
      errAck(cb, e.message || 'createRecvTransport failed');
    }
  });

  socket.on('connectRecvTransport', async ({ channelId, dtlsParameters }, cb) => {
    try {
      const ch = getChannelIdFromPayload({ channelId });
      if (!ch) return errAck(cb, 'invalid channelId');
      const t = socket.data[`recvTransport_${ch}`];
      if (!t) return errAck(cb, 'no recv transport');
      await t.connect({ dtlsParameters });
      ok(cb);
    } catch (e) {
      console.error('connectRecvTransport error', e);
      errAck(cb, e.message || 'connectRecvTransport failed');
    }
  });

  socket.on('consume', async ({ channelId, rtpCapabilities, kind }, cb) => {
    try {
      const ch = getChannelIdFromPayload({ channelId });
      if (!ch) return errAck(cb, 'invalid channelId');
      const state = channels.get(ch);
      const target = (kind === 'video') ? state.videoProducer : state.audioProducer;
      if (!target) return errAck(cb, `no ${kind} producer`);
      if (!router.canConsume({ producerId: target.id, rtpCapabilities })) return errAck(cb, 'cannot consume');

      const t = socket.data[`recvTransport_${ch}`];
      if (!t) return errAck(cb, 'no recv transport');

      const consumer = await t.consume({ producerId: target.id, rtpCapabilities, paused: true });

      const list = consumers.get(socket.id) || [];
      list.push(consumer);
      consumers.set(socket.id, list);

      if (consumer.kind === 'video') {
        socket.data[`videoConsumer_${ch}`] = consumer;
      }

      consumer.on('transportclose', () => console.log(`[${ch}] ${kind} consumer transport closed`));
      consumer.on('producerclose', () => console.log(`[${ch}] ${kind} producer closed -> consumer closed`));

      ok(cb, {
        id: consumer.id,
        producerId: target.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      });
    } catch (e) {
      console.error('consume error', e);
      errAck(cb, e.message || 'consume failed');
    }
  });

  socket.on('resume', async ({ consumerId }, cb) => {
    try {
      const list = consumers.get(socket.id) || [];
      const c = list.find(x => x.id === consumerId);
      if (!c) return errAck(cb, 'consumer not found');
      await c.resume();
      ok(cb);
    } catch (e) {
      console.error('resume error', e);
      errAck(cb, e.message || 'resume failed');
    }
  });

  // let viewer change preferred simulcast layer (for quality menu)
  socket.on('setPreferredLayers', async ({ channelId, spatialLayer = 2, temporalLayer = null }, cb) => {
    try {
      const ch = getChannelIdFromPayload({ channelId });
      if (!ch) return errAck(cb, 'invalid channelId');
      const c = socket.data[`videoConsumer_${ch}`];
      if (!c) return errAck(cb, 'no video consumer yet');
      await c.setPreferredLayers({ spatialLayer, temporalLayer });
      ok(cb);
    } catch (e) {
      console.error('setPreferredLayers error', e);
      errAck(cb, e.message || 'setPreferredLayers failed');
    }
  });

  socket.on('disconnect', () => {
    // Close any transports/consumers we created (keep simple cleanup)
    for (const ch of CHANNEL_IDS) {
      try { socket.data[`sendTransport_${ch}`]?.close(); } catch {}
      try { socket.data[`recvTransport_${ch}`]?.close(); } catch {}
      // ensure viewer count updates if this socket was in any room
      broadcastViewerCount(ch);
    }
    const list = consumers.get(socket.id) || [];
    for (const c of list) { try { c.close(); } catch {} }
    consumers.delete(socket.id);
  });
});

// -------- Global crash guards --------
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
