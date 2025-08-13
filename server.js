// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

const PORT = process.env.PORT || 3000;
// Set to your EC2 public/elastic IP (or pass ANNOUNCED_IP via env for PM2).
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '13.210.150.18';
const WEBRTC_MIN_PORT = 40000;
const WEBRTC_MAX_PORT = 49999;

const app = express();
app.use(express.static('public')); // serve /public as web root
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---- Mediasoup state ----
let worker, router;
let videoProducer = null;
let audioProducer = null;

const consumers = new Map(); // socket.id -> Consumer[]
const ROOM = 'main';

// Add H264 for iOS/Safari (keep VP8 too)
// server.js
const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'level-asymmetry-allowed': 1,
      'packetization-mode': 1,
      'profile-level-id': '42e01f' // Baseline; widely compatible on iOS
    }
  },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
];
;

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
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });
  return transport;
}

function broadcastViewerCount() {
  const count = io.sockets.adapter.rooms.get(ROOM)?.size || 0;
  io.to(ROOM).emit('viewerCount', { count });
  // Also tell everyone (so broadcaster can see it)
  io.emit('viewerCount', { count });
}

io.on('connection', (socket) => {
  console.log('client connected', socket.id);

  // --- Rooms / viewer count ---
  socket.on('join', () => {
    socket.join(ROOM);
    broadcastViewerCount();
  });
  socket.on('leave', () => {
    socket.leave(ROOM);
    broadcastViewerCount();
  });

  socket.on('getRtpCapabilities', (cb) => cb(router.rtpCapabilities));

  // --- Broadcaster: Send transport ---
  socket.on('createSendTransport', async (cb) => {
    try {
      const transport = await createWebRtcTransport();
      socket.data.sendTransport = transport;
      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
    } catch (err) {
      console.error('createSendTransport error', err);
      cb({ error: err.message });
    }
  });

  socket.on('connectSendTransport', async ({ dtlsParameters }, cb) => {
    try { await socket.data.sendTransport.connect({ dtlsParameters }); cb('ok'); }
    catch (err) { console.error('connectSendTransport error', err); cb({ error: err.message }); }
  });

  socket.on('produce', async ({ kind, rtpParameters }, cb) => {
    try {
      if (!socket.data.sendTransport) return cb({ error: 'no send transport' });
      const producer = await socket.data.sendTransport.produce({ kind, rtpParameters });

      if (kind === 'video') {
        try { await videoProducer?.close(); } catch {}
        videoProducer = producer;
        io.to(ROOM).emit('newProducer', { kind: 'video' }); // notify viewers to re-subscribe
      } else if (kind === 'audio') {
        try { await audioProducer?.close(); } catch {}
        audioProducer = producer;
        io.to(ROOM).emit('newProducer', { kind: 'audio' });
      }

      producer.on('transportclose', () => console.log(`${kind} producer transport closed`));
      producer.on('close', () => console.log(`${kind} producer closed`));
      cb({ id: producer.id });
    } catch (err) {
      console.error('produce error', err);
      cb({ error: err.message });
    }
  });

  // --- Viewer: Recv transport ---
  socket.on('createRecvTransport', async (cb) => {
    try {
      const transport = await createWebRtcTransport();
      socket.data.recvTransport = transport;
      cb({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
    } catch (err) {
      console.error('createRecvTransport error', err);
      cb({ error: err.message });
    }
  });

  socket.on('connectRecvTransport', async ({ dtlsParameters }, cb) => {
    try { await socket.data.recvTransport.connect({ dtlsParameters }); cb('ok'); }
    catch (err) { console.error('connectRecvTransport error', err); cb({ error: err.message }); }
  });

  socket.on('consume', async ({ rtpCapabilities, kind }, cb) => {
    try {
      const target = kind === 'video' ? videoProducer : audioProducer;
      if (!target) return cb({ error: `no ${kind} producer` });

      if (!router.canConsume({ producerId: target.id, rtpCapabilities })) {
        return cb({ error: 'cannot consume' });
      }

      const consumer = await socket.data.recvTransport.consume({
        producerId: target.id,
        rtpCapabilities,
        paused: true
      });

      const list = consumers.get(socket.id) || [];
      list.push(consumer);
      consumers.set(socket.id, list);

      consumer.on('transportclose', () => console.log(`${kind} consumer transport closed`));
      consumer.on('producerclose', () => console.log(`${kind} producer closed -> consumer closed`));

      cb({
        id: consumer.id,
        producerId: target.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      });
    } catch (err) {
      console.error('consume error', err);
      cb({ error: err.message });
    }
  });

  socket.on('resume', async ({ consumerId }, cb) => {
    const list = consumers.get(socket.id) || [];
    const c = list.find(x => x.id === consumerId);
    if (c) await c.resume();
    cb('ok');
  });

  socket.on('disconnect', () => {
    try { socket.leave(ROOM); } catch {}
    broadcastViewerCount();
    try { socket.data.sendTransport?.close(); } catch {}
    try { socket.data.recvTransport?.close(); } catch {}
    const list = consumers.get(socket.id) || [];
    for (const c of list) { try { c.close(); } catch {} }
    consumers.delete(socket.id);
    console.log('client disconnected', socket.id);
  });
});
