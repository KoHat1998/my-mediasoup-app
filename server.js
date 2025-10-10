// server.js — KoHat Live (multi-room, auth-optional with TEST_AUTH_BYPASS)

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

// Friend backend (optional)
const AUTH_BASE = process.env.AUTH_BASE || 'https://livenix.duckdns.org/api';

// --------------- tiny fetch helpers ---------------
async function getFetch() {
  if (typeof fetch === 'function') return fetch;
  const { default: nodeFetch } = await import('node-fetch');
  return nodeFetch;
}
async function httpJSON(url, options = {}) {
  const f = await getFetch();
  const r = await f(url, { headers: { 'Content-Type': 'application/json', ...(options.headers||{}) }, ...options });
  let data, text; try { data = await r.json(); } catch { try { text = await r.text(); } catch { text = '<no body>'; } }
  if (!r.ok) throw new Error((data && (data.message||data.error)) || text || `HTTP ${r.status}`);
  return data ?? {};
}
async function httpForm(url, fields = {}, headers = {}) {
  const f = await getFetch();
  let FormDataCtor = typeof FormData !== 'undefined' ? FormData : null;
  if (!FormDataCtor) { const mod = await import('form-data'); FormDataCtor = mod.default; }
  const form = new FormDataCtor(); Object.entries(fields).forEach(([k,v]) => form.append(k,v));
  const r = await f(url, { method: 'POST', headers: { Accept:'application/json', ...headers }, body: form });
  let data, text; try { data = await r.json(); } catch { try { text = await r.text(); } catch { text = '<no body>'; } }
  if (!r.ok) throw new Error((data && (data.message||data.error)) || text || `HTTP ${r.status}`);
  return data ?? {};
}

// ---------------- App / Socket ----------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000','http://127.0.0.1:3000','https://livenix.htetaungthant.com'],
    methods: ['GET','POST','PATCH','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization']
  }
});

// ---------------- Mediasoup ----------------
let worker, router;
const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8',  clockRate: 90000 },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'level-asymmetry-allowed': 1, 'packetization-mode': 1, 'profile-level-id': '42e01f' } }
];

(async () => {
  worker = await mediasoup.createWorker({ rtcMinPort: WEBRTC_MIN_PORT, rtcMaxPort: WEBRTC_MAX_PORT });
  worker.on('died', () => { console.error('💥 mediasoup worker died, exiting in 2s...'); setTimeout(()=>process.exit(1), 2000); });
  router = await worker.createRouter({ mediaCodecs });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
    console.log(`🌐 ANNOUNCED_IP = ${ANNOUNCED_IP}`);
    if (TEST_AUTH_BYPASS) console.log('⚠️ TEST_AUTH_BYPASS is ON');
  });
})();

async function createWebRtcTransport() {
  return router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
    enableUdp: true, enableTcp: true, preferUdp: true
  });
}

// ---------------- Lives store ----------------
const lives = new Map(); // id -> live

function makeSlug(title='live'){
  const base = String(title).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0,40) || 'live';
  return `${base}-${Math.random().toString(36).slice(2,6)}`;
}
function findLiveBySlug(slug){ return Array.from(lives.values()).find(l => l.slug === slug) || null; }
function ensureLiveState(liveId){
  const live = lives.get(liveId); if (!live) return null;
  if (!live.state) {
    live.state = { transports:new Map(), videoProducer:null, audioProducer:null, roomName:`live:${liveId}`, consumersBySocket:new Map(), videoConsumerBySocket:new Map() };
  }
  return live.state;
}
function broadcastViewers(liveId){
  const live = lives.get(liveId); if (!live || !live.state) return;
  const rn = live.state.roomName; const members = io.sockets.adapter.rooms.get(rn) || new Set();
  io.to(rn).emit('viewers', members.size);
}
function getOrCreateLiveFromHint(hint){
  const bySlug = findLiveBySlug(hint); if (bySlug) return bySlug;
  if (lives.has(hint)) return lives.get(hint);
  const id = hint;
  const live = { id, slug: hint, title: `Live ${hint}`, description: null, hostUserId: 'auto', isLive: true, createdAt: new Date().toISOString(), endedAt: null, state:null };
  lives.set(id, live); ensureLiveState(id); console.log('ℹ️ created live from hint:', { id: live.id, slug: live.slug }); return live;
}

// ---------------- Auth helper ----------------
function requireAuthHeader(req, res, next){
  if (TEST_AUTH_BYPASS) { req.user = { token: 'fake', raw: 'Bearer fake' }; return next(); }
  const h = req.headers.authorization || '';
  if (!/^Bearer\s+/i.test(h)) return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });
  req.user = { token: h.trim().replace(/^Bearer\s+/i, ''), raw: h }; next();
}

// ---------------- REST ----------------
app.post('/api/lives', requireAuthHeader, async (req, res) => {
  const { title, description, hostName, hostEmail } = req.body || {};
  const id = randomUUID(); const slug = makeSlug(title || 'live');
  const live = {
    id, slug, title: title || 'Untitled Live', description: description || null,
    hostUserId: 'token:' + (req.user.token || '').slice(0,12),
    host: { name: (hostName || '').toString().slice(0,80) || null, email: (hostEmail || '').toString().slice(0,120) || null },
    isLive: true, createdAt: new Date().toISOString(), endedAt: null, state: null
  };
  lives.set(id, live); ensureLiveState(id);
  try { await httpForm(`${AUTH_BASE}/streams/start`, { stream_id: live.id, title: live.title }, { Authorization: req.user?.raw || '' }); io.emit('streams:changed', { type:'start', id: live.id, slug: live.slug, title: live.title }); } catch(e){ console.warn('streams/start failed:', e.message); }
  res.json(live);
});

app.get('/api/lives', requireAuthHeader, async (_req, res) => {
  const list = Array.from(lives.values()).filter(l=>l.isLive).map(l=>({
    id:l.id, slug:l.slug, title:l.title, description:l.description, createdAt:l.createdAt,
    hostName:l.host?.name||null, hostEmail:l.host?.email||null
  }));
  res.json(list);
});

app.patch('/api/lives/:id/end', requireAuthHeader, async (req, res) => {
  const live = lives.get(req.params.id); if (!live) return res.status(404).json({ error:'Not found' });
  live.isLive = false; live.endedAt = new Date().toISOString();
  if (live.state) {
    try { for (const [,t] of live.state.transports) { try{t.send?.close();}catch{} try{t.recv?.close();}catch{} } live.state.videoProducer?.close?.(); live.state.audioProducer?.close?.(); } catch {}
  }
  try { await httpForm(`${AUTH_BASE}/streams/stop`, { stream_id: live.id }, { Authorization: req.user?.raw || '' }); io.emit('streams:changed', { type:'stop', id: live.id, slug: live.slug }); } catch(e){ console.warn('streams/stop failed:', e.message); }
  res.json({ ok:true });
});

// ---------------- Static ----------------
app.get('/healthz', (_req, res) => res.json({ ok:true }));
app.get('/', (_req, res) => res.redirect('/lives.html'));
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) { res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate'); res.set('Pragma','no-cache'); res.set('Expires','0'); res.set('Surrogate-Control','no-store'); }
  next();
});
app.use(express.static('public', { etag:false, lastModified:false, maxAge:0 }));

// IMPORTANT: let the static file handle /player_only.html
// (do NOT send an inline HTML string here)

// ---------------- Socket.IO ----------------
io.use((socket, next) => {
  const { role, token: raw, liveId: hintedLiveId, slug: hintedSlug } = socket.handshake.auth || {};
  const token = raw ? (/^Bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`) : '';
  if (!TEST_AUTH_BYPASS && !token) return next(new Error('auth required'));

  let live = lives.get(hintedLiveId) || findLiveBySlug(hintedSlug);
  if (!live) { const hint = hintedSlug || hintedLiveId; if (!hint) return next(new Error('live not found')); live = getOrCreateLiveFromHint(hint); }

  socket.data = { role: (role||'viewer').toLowerCase(), token: token || 'Bearer fake', liveId: live.id, slug: live.slug, isHost: (role||'viewer').toLowerCase() === 'broadcaster' };
  next();
});

io.on('connection', (socket) => {
  const liveId = socket.data.liveId;
  const live = lives.get(liveId);
  if (!live || !live.isLive) { socket.emit('error', 'Live not available'); return socket.disconnect(true); }

  const state = ensureLiveState(liveId);
  const roomName = state.roomName;
  socket.join(roomName);
  broadcastViewers(liveId);

  const ok = (cb, payload='ok') => { try { (cb||(()=>{}))(payload); } catch(e) {} };
  const bad = (cb, msg) => ok(cb, { error: msg });

  socket.on('getRtpCapabilities', (_p, cb) => ok(cb, router.rtpCapabilities));

  // broadcaster (send)
  socket.on('createSendTransport', async (_p, cb) => {
    try {
      if (!socket.data.isHost) return bad(cb, 'not host');
      const t = await createWebRtcTransport();
      state.transports.set(socket.id, { ...(state.transports.get(socket.id)||{}), send: t });
      ok(cb, { id:t.id, iceParameters:t.iceParameters, iceCandidates:t.iceCandidates, dtlsParameters:t.dtlsParameters });
    } catch(e){ console.error('createSendTransport', e); bad(cb,'createSendTransport failed'); }
  });
  socket.on('connectSendTransport', async ({ dtlsParameters }, cb) => {
    try {
      if (!socket.data.isHost) return bad(cb,'not host');
      const t = (state.transports.get(socket.id)||{}).send; if (!t) return bad(cb,'no send transport');
      await t.connect({ dtlsParameters }); ok(cb);
    } catch(e){ console.error('connectSendTransport', e); bad(cb,'connectSendTransport failed'); }
  });
  socket.on('produce', async ({ kind, rtpParameters }, cb) => {
    try {
      if (!socket.data.isHost) return bad(cb,'not host');
      const t = (state.transports.get(socket.id)||{}).send; if (!t) return bad(cb,'no send transport');
      const producer = await t.produce({ kind, rtpParameters });
      if (kind === 'video') { await state.videoProducer?.close?.(); state.videoProducer = producer; io.to(roomName).emit('newProducer', { kind:'video', slug: live.slug }); }
      else { await state.audioProducer?.close?.(); state.audioProducer = producer; io.to(roomName).emit('newProducer', { kind:'audio', slug: live.slug }); }
      producer.on('transportclose', () => { if (kind === 'video') state.videoProducer = null; else state.audioProducer = null; });
      producer.on('close',         () => { if (kind === 'video') state.videoProducer = null; else state.audioProducer = null; });
      ok(cb, { id: producer.id });
    } catch(e){ console.error('produce', e); bad(cb,'produce failed'); }
  });

  // viewer (recv)
  socket.on('createRecvTransport', async (_p, cb) => {
    try {
      const t = await createWebRtcTransport();
      state.transports.set(socket.id, { ...(state.transports.get(socket.id)||{}), recv: t });
      ok(cb, { id:t.id, iceParameters:t.iceParameters, iceCandidates:t.iceCandidates, dtlsParameters:t.dtlsParameters });
    } catch(e){ console.error('createRecvTransport', e); bad(cb,'createRecvTransport failed'); }
  });
  socket.on('connectRecvTransport', async ({ dtlsParameters }, cb) => {
    try {
      const t = (state.transports.get(socket.id)||{}).recv; if (!t) return bad(cb,'no recv transport');
      await t.connect({ dtlsParameters }); ok(cb);
    } catch(e){ console.error('connectRecvTransport', e); bad(cb,'connectRecvTransport failed'); }
  });
  socket.on('consume', async ({ rtpCapabilities, kind }, cb) => {
    try {
      const prod = kind === 'video' ? state.videoProducer : state.audioProducer;
      if (!prod) return bad(cb, `no ${kind} producer`);
      if (!router.canConsume({ producerId: prod.id, rtpCapabilities })) return bad(cb, 'cannot consume');
      const t = (state.transports.get(socket.id)||{}).recv; if (!t) return bad(cb,'no recv transport');
      const c = await t.consume({ producerId: prod.id, rtpCapabilities, paused: true });
      const list = state.consumersBySocket.get(socket.id) || []; list.push(c); state.consumersBySocket.set(socket.id, list);
      if (kind === 'video') state.videoConsumerBySocket.set(socket.id, c);
      ok(cb, { id:c.id, producerId: prod.id, kind:c.kind, rtpParameters:c.rtpParameters });
    } catch(e){ console.error('consume', e); bad(cb,'consume failed'); }
  });
  socket.on('resume', async ({ consumerId }, cb) => {
    try {
      const list = state.consumersBySocket.get(socket.id) || []; const c = list.find(x => x.id === consumerId);
      if (!c) return bad(cb,'consumer not found'); await c.resume(); ok(cb);
    } catch(e){ console.error('resume', e); bad(cb,'resume failed'); }
  });
  socket.on('setPreferredLayers', async ({ spatialLayer = 2, temporalLayer = null }, cb) => {
    try {
      const c = state.videoConsumerBySocket.get(socket.id); if (!c) return bad(cb,'no video consumer yet');
      await c.setPreferredLayers({ spatialLayer, temporalLayer }); ok(cb);
    } catch(e){ console.error('setPreferredLayers', e); bad(cb,'setPreferredLayers failed'); }
  });

  socket.on('disconnect', () => {
    try {
      const t = state.transports.get(socket.id);
      if (t?.send) try{ t.send.close(); }catch{}
      if (t?.recv) try{ t.recv.close(); }catch{}
      state.transports.delete(socket.id);
      const list = state.consumersBySocket.get(socket.id) || [];
      for (const c of list) { try { c.close(); } catch {} }
      state.consumersBySocket.delete(socket.id); state.videoConsumerBySocket.delete(socket.id);
    } catch {}
    broadcastViewers(liveId);
  });
});

// ---------------- Error handler ----------------  
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
