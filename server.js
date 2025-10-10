// server.js — KoHat Live (multi-room, auth-optional with TEST_AUTH_BYPASS; integrates friend /streams APIs)

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const { randomUUID } = require('crypto');

// ---------------- Config ----------------
const PORT = process.env.PORT || 3000;
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '52.62.49.247';
const WEBRTC_MIN_PORT = parseInt(process.env.WEBRTC_MIN_PORT || '40000', 10);
const WEBRTC_MAX_PORT = parseInt(process.env.WEBRTC_MAX_PORT || '49999', 10);
const TEST_AUTH_BYPASS = String(process.env.TEST_AUTH_BYPASS || '').toLowerCase() === 'true';

// Your friend’s backend base (used for /login, /streams/start, /streams/stop)
const AUTH_BASE = process.env.AUTH_BASE || 'https://livenix.duckdns.org/api';

// ---------------- Small HTTP helpers ----------------
async function getFetch() {
  if (typeof fetch === 'function') return fetch;
  const { default: nodeFetch } = await import('node-fetch');
  return nodeFetch;
}

async function httpJSON(url, options = {}) {
  const f = await getFetch();
  const r = await f(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  let data, text;
  try { data = await r.json(); }
  catch { try { text = await r.text(); } catch { text = '<no body>'; } }

  if (!r.ok) {
    const msg = (data && (data.message || data.error)) || text || `HTTP ${r.status}`;
    throw new Error(`HTTP ${r.status} – ${msg}`);
  }
  return data ?? {};
}

async function httpForm(url, fields = {}, headers = {}) {
  const f = await getFetch();

  let FormDataCtor = typeof FormData !== 'undefined' ? FormData : null;
  if (!FormDataCtor) {
    const mod = await import('form-data');
    FormDataCtor = mod.default;
  }
  const form = new FormDataCtor();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));

  const r = await f(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      ...headers
    },
    body: form
  });

  let data, text;
  try { data = await r.json(); }
  catch { try { text = await r.text(); } catch { text = '<no body>'; } }

  if (!r.ok) {
    const msg = (data && (data.message || data.error)) || text || `HTTP ${r.status}`;
    throw new Error(`HTTP ${r.status} – ${msg}`);
  }
  return data ?? {};
}

// ---------------- App / Socket ----------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://livenix.htetaungthant.com'
    ],
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }
});

// ---------------- Mediasoup core ----------------
let worker, router;
const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'level-asymmetry-allowed': 1,
      'packetization-mode': 1,
      'profile-level-id': '42e01f'
    }
  }
];

(async () => {
  worker = await mediasoup.createWorker({ rtcMinPort: WEBRTC_MIN_PORT, rtcMaxPort: WEBRTC_MAX_PORT });
  worker.on('died', () => {
    console.error('💥 mediasoup worker died, exiting in 2s...');
    setTimeout(() => process.exit(1), 2000);
  });
  router = await worker.createRouter({ mediaCodecs });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
    console.log(`🌐 ANNOUNCED_IP = ${ANNOUNCED_IP}`);
    if (TEST_AUTH_BYPASS) console.log('⚠️ TEST_AUTH_BYPASS is ON — all requests are auto-authorized.');
    console.log(`🔗 Friend API base = ${AUTH_BASE}`);
  });
})();

async function createWebRtcTransport() {
  return router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });
}

// ---------------- Lives store (in-memory) ----------------
const lives = new Map(); // id -> live

function makeSlug(title = 'live') {
  const base = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'live';
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

function findLiveBySlug(slug) {
  return Array.from(lives.values()).find((l) => l.slug === slug) || null;
}

function ensureLiveState(liveId) {
  const live = lives.get(liveId);
  if (!live) return null;
  if (!live.state) {
    live.state = {
      transports: new Map(),
      videoProducer: null,
      audioProducer: null,
      roomName: `live:${liveId}`,
      consumersBySocket: new Map(),
      videoConsumerBySocket: new Map()
    };
  }
  return live.state;
}

function broadcastViewers(liveId) {
  const live = lives.get(liveId);
  if (!live || !live.state) return;
  const rn = live.state.roomName;
  const members = io.sockets.adapter.rooms.get(rn) || new Set();
  io.to(rn).emit('viewers', members.size);
}

/** Lazily create a live when a viewer/broadcaster connects with an unknown id/slug. */
function getOrCreateLiveFromHint(hint) {
  const bySlug = findLiveBySlug(hint);
  if (bySlug) return bySlug;

  if (lives.has(hint)) return lives.get(hint);

  const id = hint; // keep stable so broadcaster & viewers use the same key
  const live = {
    id,
    slug: hint,
    title: `Live ${hint}`,
    description: null,
    hostUserId: 'auto',
    isLive: true,
    createdAt: new Date().toISOString(),
    endedAt: null,
    state: null
  };
  lives.set(id, live);
  ensureLiveState(id);
  console.log('ℹ️ created live from hint:', { id: live.id, slug: live.slug });
  return live;
}

// ---------------- Auth Helper ----------------
function requireAuthHeader(req, res, next) {
  if (TEST_AUTH_BYPASS) {
    req.user = { token: 'fake', raw: 'Bearer fake' };
    return next();
  }
  const h = req.headers.authorization || '';
  if (!/^Bearer\s+/i.test(h)) return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });
  req.user = { token: h.trim().replace(/^Bearer\s+/i, ''), raw: h };
  next();
}

// ---------------- REST: Lives ----------------
app.post('/api/lives', requireAuthHeader, async (req, res) => {
  const { title, description } = req.body || {};
  const id = randomUUID();
  const slug = makeSlug(title || 'live');
  const live = {
    id,
    slug,
    title: title || 'Untitled Live',
    description: description || null,
    hostUserId: 'token:' + (req.user.token || '').slice(0, 12),
    isLive: true,
    createdAt: new Date().toISOString(),
    endedAt: null,
    state: null
  };
  lives.set(id, live);
  ensureLiveState(id);

  try {
    await httpForm(`${AUTH_BASE}/streams/start`,
      { stream_id: live.id, title: live.title },
      { Authorization: req.user?.raw || '' }
    );
    io.emit('streams:changed', { type: 'start', id: live.id, slug: live.slug, title: live.title });
  } catch (e) {
    console.warn('⚠️ Failed to sync /streams/start:', e.message);
  }

  res.json(live);
});

app.get('/api/lives', requireAuthHeader, async (_req, res) => {
  const list = Array.from(lives.values())
    .filter((l) => l.isLive)
    .map((l) => ({
      id: l.id,
      slug: l.slug,
      title: l.title,
      description: l.description,
      createdAt: l.createdAt
    }));
  return res.json(list);
});

app.patch('/api/lives/:id/end', requireAuthHeader, async (req, res) => {
  const live = lives.get(req.params.id);
  if (!live) return res.status(404).json({ error: 'Not found' });

  live.isLive = false;
  live.endedAt = new Date().toISOString();

  if (live.state) {
    try {
      for (const [, t] of live.state.transports) {
        try { t.send?.close(); } catch {}
        try { t.recv?.close(); } catch {}
      }
      try { live.state.videoProducer?.close(); } catch {}
      try { live.state.audioProducer?.close(); } catch {}
    } catch {}
  }

  try {
    await httpForm(`${AUTH_BASE}/streams/stop`,
      { stream_id: live.id },
      { Authorization: req.user?.raw || '' }
    );
    io.emit('streams:changed', { type: 'stop', id: live.id, slug: live.slug });
  } catch (e) {
    console.warn('⚠️ Failed to sync /streams/stop:', e.message);
  }

  res.json({ ok: true });
});

// ---------------- Static Routes ----------------
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => res.redirect('/lives.html'));
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
  next();
});
app.use(express.static('public', { etag: false, lastModified: false, maxAge: 0 }));

/* -------- Inline viewer: /player_only.html (also /viewer, /viewer.html) -------- */
const PLAYER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>KoHat Live Viewer</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, 'Helvetica Neue', Arial; }
    .wrap { display:flex; flex-direction:column; min-height:100vh; }
    header { padding:10px 14px; border-bottom:1px solid #00000022; display:flex; align-items:center; gap:10px; }
    header h1 { margin:0; font-size:16px; font-weight:600; }
    main { flex:1; display:flex; align-items:center; justify-content:center; padding:10px; }
    video { width: min(100vw, 100%); max-height: 70vh; background:#000; border-radius:10px; }
    .row { display:flex; gap:8px; align-items:center; }
    .pill { padding:4px 8px; border-radius:999px; font-size:12px; background:#2563eb; color:white; }
    .err { color:#ef4444; font-weight:600; }
    footer { padding:8px 14px; border-top:1px solid #00000022; display:flex; justify-content:space-between; align-items:center; font-size:12px; opacity:.8;}
    .muted { opacity:.7 }
    button { padding:8px 12px; border-radius:8px; border:1px solid #00000022; background:#111827; color:white; cursor:pointer;}
    button:disabled{ opacity:.5; cursor:not-allowed;}
  </style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="row"><span class="pill" id="status">Idle</span></div>
    <h1 id="title">Viewer</h1>
    <div style="margin-left:auto" class="muted" id="info"></div>
  </header>
  <main>
    <video id="video" playsinline autoplay muted controls></video>
  </main>
  <footer>
    <div class="muted">Press play if your browser blocks autoplay.</div>
    <div><button id="unmute">Unmute</button></div>
  </footer>
</div>

<script src="/socket.io/socket.io.js"></script>
<script type="module">
  import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

  const qs = new URLSearchParams(location.search);
  const ident = qs.get('slug') || qs.get('liveId') || qs.get('id') || qs.get('room') || qs.get('ch') || '';
  const token = qs.get('token') || ''; // optional

  const $status = document.getElementById('status');
  const $title  = document.getElementById('title');
  const $info   = document.getElementById('info');
  const $video  = document.getElementById('video');
  const $unmute = document.getElementById('unmute');

  $title.textContent = 'Viewer: ' + (ident || '(no id)');
  $info.textContent = location.host;

  function setStatus(s, bad=false){
    $status.textContent = s;
    $status.style.background = bad ? '#ef4444' : '#2563eb';
  }

  if (!ident) {
    setStatus('Missing id/slug', true);
    throw new Error('Provide ?slug= or ?liveId= or ?id= or ?room=');
  }

  setStatus('Connecting…');
  const socket = io('/', {
    transports: ['websocket'],
    auth: {
      role: 'viewer',
      token: token ? (/^Bearer\\s+/i.test(token) ? token : 'Bearer ' + token) : undefined,
      slug: ident,
      liveId: ident
    }
  });

  socket.on('connect', async () => {
    try {
      setStatus('Loading caps…');
      const rtpCaps = await emitAck('getRtpCapabilities', null);

      const device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities: rtpCaps });

      setStatus('Creating transport…');
      const tInfo = await emitAck('createRecvTransport', null);
      const recvTransport = device.createRecvTransport(tInfo);

      recvTransport.on('connect', ({ dtlsParameters }, cb, err) => {
        emitAck('connectRecvTransport', { dtlsParameters }).then(cb).catch(err);
      });

      async function consumeKind(kind) {
        const res = await emitAck('consume', { rtpCapabilities: device.rtpCapabilities, kind });
        if (res?.error) throw new Error(res.error);
        const consumer = await recvTransport.consume({
          id: res.id,
          producerId: res.producerId,
          kind: res.kind,
          rtpParameters: res.rtpParameters
        });
        const ms = new MediaStream([consumer.track]);
        if (kind === 'video') $video.srcObject = ms;
        await emitAck('resume', { consumerId: consumer.id });
        return consumer;
      }

      setStatus('Starting video…');
      try { await consumeKind('video'); } catch(e){ console.warn('video:', e); }

      setStatus('Starting audio…');
      try { await consumeKind('audio'); } catch(e){ console.warn('audio:', e); }

      setStatus('LIVE');

      socket.on('newProducer', async (p) => {
        try {
          if (p.kind === 'video') { await consumeKind('video'); }
          if (p.kind === 'audio') { await consumeKind('audio'); }
        } catch(e) { console.warn('newProducer consume failed:', e); }
      });

    } catch (e) {
      console.error(e);
      setStatus('Error', true);
      alert('Viewer error: ' + (e?.message || e));
    }
  });

  socket.on('connect_error', (e) => {
    console.error('connect_error', e);
    setStatus('Connect error', true);
  });

  function emitAck(event, payload){
    return new Promise((resolve, reject) => {
      socket.timeout(8000).emit(event, payload, (res) => {
        if (res && res.error) return reject(new Error(res.error));
        resolve(res);
      });
    });
  }

  $unmute.addEventListener('click', async () => {
    try {
      $video.muted = false;
      await $video.play().catch(()=>{});
    } catch (_) {}
  });
</script>
</body>
</html>`;

app.get(['/player_only.html', '/viewer', '/viewer.html'], (_req, res) => {
  res.type('html').send(PLAYER_HTML);
});

// ---------------- Socket.IO ----------------
// ✔ Lazy-create a live if none exists for the provided slug/liveId
io.use((socket, next) => {
  const { role, token: raw, liveId: hintedLiveId, slug: hintedSlug } = socket.handshake.auth || {};
  const token = raw ? (/^Bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`) : '';

  if (!TEST_AUTH_BYPASS && !token) return next(new Error('auth required'));

  // Find the live by id/slug, or lazily create it
  let live = lives.get(hintedLiveId) || findLiveBySlug(hintedSlug);
  if (!live) {
    const hint = hintedSlug || hintedLiveId;
    if (!hint) return next(new Error('live not found'));
    live = getOrCreateLiveFromHint(hint);
  }

  socket.data = {
    role: (role || 'viewer').toLowerCase(),
    token: token || 'Bearer fake',
    liveId: live.id,
    slug: live.slug,
    isHost: (role || 'viewer').toLowerCase() === 'broadcaster',
  };
  next();
});



io.engine.on('connection_error', (err) => {
  console.error('engine.io connection_error:', {
    code: err.code,
    message: err.message,
    context: err.context
  });
});

io.on('connection', (socket) => {
  const liveId = socket.data.liveId;
  const live = lives.get(liveId);
  if (!live || !live.isLive) {
    socket.emit('error', 'Live not available');
    return socket.disconnect(true);
  }

  const state = ensureLiveState(liveId);
  const roomName = state.roomName;
  socket.join(roomName);
  broadcastViewers(liveId);

  const ok = (cb, payload = 'ok') => { try { (cb || (() => {}))(payload); } catch (e) { console.error('ack error', e); } };
  const errAck = (cb, msg) => ok(cb, { error: msg });

  socket.on('getRtpCapabilities', (_payload, cb) => ok(cb, router.rtpCapabilities));

  // ---- Broadcaster (send)
  socket.on('createSendTransport', async (_payload, cb) => {
    try {
      if (!socket.data.isHost) return errAck(cb, 'not host');
      const t = await createWebRtcTransport();
      state.transports.set(socket.id, { ...(state.transports.get(socket.id) || {}), send: t });
      ok(cb, { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters });
    } catch (e) { console.error('createSendTransport', e); errAck(cb, 'createSendTransport failed'); }
  });

  socket.on('connectSendTransport', async ({ dtlsParameters }, cb) => {
    try {
      if (!socket.data.isHost) return errAck(cb, 'not host');
      const t = (state.transports.get(socket.id) || {}).send;
      if (!t) return errAck(cb, 'no send transport');
      await t.connect({ dtlsParameters });
      ok(cb);
    } catch (e) { console.error('connectSendTransport', e); errAck(cb, 'connectSendTransport failed'); }
  });

  socket.on('produce', async ({ kind, rtpParameters }, cb) => {
    try {
      if (!socket.data.isHost) return errAck(cb, 'not host');
      const t = (state.transports.get(socket.id) || {}).send;
      if (!t) return errAck(cb, 'no send transport');
      const producer = await t.produce({ kind, rtpParameters });

      if (kind === 'video') {
        await state.videoProducer?.close().catch(() => {});
        state.videoProducer = producer;
        io.to(roomName).emit('newProducer', { kind: 'video', slug: live.slug });
      } else {
        await state.audioProducer?.close().catch(() => {});
        state.audioProducer = producer;
        io.to(roomName).emit('newProducer', { kind: 'audio', slug: live.slug });
      }

      producer.on('transportclose', () => { if (kind === 'video') state.videoProducer = null; else state.audioProducer = null; });
      producer.on('close', () => { if (kind === 'video') state.videoProducer = null; else state.audioProducer = null; });

      ok(cb, { id: producer.id });
    } catch (e) { console.error('produce', e); errAck(cb, 'produce failed'); }
  });

  // ---- Viewer (recv)
  socket.on('createRecvTransport', async (_payload, cb) => {
    try {
      const t = await createWebRtcTransport();
      state.transports.set(socket.id, { ...(state.transports.get(socket.id) || {}), recv: t });
      ok(cb, { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters });
    } catch (e) { console.error('createRecvTransport', e); errAck(cb, 'createRecvTransport failed'); }
  });

  socket.on('connectRecvTransport', async ({ dtlsParameters }, cb) => {
    try {
      const t = (state.transports.get(socket.id) || {}).recv;
      if (!t) return errAck(cb, 'no recv transport');
      await t.connect({ dtlsParameters });
      ok(cb);
    } catch (e) { console.error('connectRecvTransport', e); errAck(cb, 'connectRecvTransport failed'); }
  });

  socket.on('consume', async ({ rtpCapabilities, kind }, cb) => {
    try {
      const prod = kind === 'video' ? state.videoProducer : state.audioProducer;
      if (!prod) return errAck(cb, `no ${kind} producer`);
      if (!router.canConsume({ producerId: prod.id, rtpCapabilities })) return errAck(cb, 'cannot consume');
      const t = (state.transports.get(socket.id) || {}).recv;
      if (!t) return errAck(cb, 'no recv transport');
      const c = await t.consume({ producerId: prod.id, rtpCapabilities, paused: true });

      const list = state.consumersBySocket.get(socket.id) || [];
      list.push(c);
      state.consumersBySocket.set(socket.id, list);
      if (kind === 'video') state.videoConsumerBySocket.set(socket.id, c);

      ok(cb, { id: c.id, producerId: prod.id, kind: c.kind, rtpParameters: c.rtpParameters });
    } catch (e) { console.error('consume', e); errAck(cb, 'consume failed'); }
  });

  socket.on('resume', async ({ consumerId }, cb) => {
    try {
      const list = state.consumersBySocket.get(socket.id) || [];
      const c = list.find((x) => x.id === consumerId);
      if (!c) return errAck(cb, 'consumer not found');
      await c.resume();
      ok(cb);
    } catch (e) { console.error('resume', e); errAck(cb, 'resume failed'); }
  });

  socket.on('setPreferredLayers', async ({ spatialLayer = 2, temporalLayer = null }, cb) => {
    try {
      const c = state.videoConsumerBySocket.get(socket.id);
      if (!c) return errAck(cb, 'no video consumer yet');
      await c.setPreferredLayers({ spatialLayer, temporalLayer });
      ok(cb);
    } catch (e) { console.error('setPreferredLayers', e); errAck(cb, 'setPreferredLayers failed'); }
  });

  socket.on('disconnect', () => {
    try {
      const t = state.transports.get(socket.id);
      if (t?.send) try { t.send.close(); } catch {}
      if (t?.recv) try { t.recv.close(); } catch {}
      state.transports.delete(socket.id);

      const list = state.consumersBySocket.get(socket.id) || [];
      for (const c of list) { try { c.close(); } catch {} }
      state.consumersBySocket.delete(socket.id);
      state.videoConsumerBySocket.delete(socket.id);
    } catch {}
    broadcastViewers(liveId);
  });
});

// ---------------- Error handler ----------------  
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
