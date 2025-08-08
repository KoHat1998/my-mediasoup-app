// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

const PORT = process.env.PORT || 3000;
// Set this to your EC2 public/elastic IP. You can also pass ANNOUNCED_IP via env.
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '13.210.150.18';
const WEBRTC_MIN_PORT = 40000;
const WEBRTC_MAX_PORT = 49999;

// Basic app
const app = express();
app.use(express.static('public')); // serve /public directory
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Mediasoup state
let worker;
let router;
let videoProducer = null;
let audioProducer = null;
const consumers = new Map(); // socket.id -> Consumer[]

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
];

(async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: WEBRTC_MIN_PORT,
    rtcMaxPort: WEBRTC_MAX_PORT
  });
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

io.on('connection', (socket) => {
  console.log('client connected', socket.id);

  socket.on('getRtpCapabilities', (cb) => {
    cb(router.rtpCapabilities);
  });

  // Broadcaster: create send transport
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
    try {
      await socket.data.sendTransport.connect({ dtlsParameters });
      cb('ok');
    } catch (err) {
      console.error('connectSendTransport error', err);
      cb({ error: err.message });
    }
  });

  socket.on('produce', async ({ kind, rtpParameters }, cb) => {
    try {
      if (!socket.data.sendTransport) return cb({ error: 'no send transport' });
      const producer = await socket.data.sendTransport.produce({ kind, rtpParameters });

      if (kind === 'video') {
        if (videoProducer) {
          try { await videoProducer.close(); } catch {}
        }
        videoProducer = producer;
      } else if (kind === 'audio') {
        if (audioProducer) {
          try { await audioProducer.close(); } catch {}
        }
        audioProducer = producer;
      }

      producer.on('transportclose', () => console.log(`${kind} producer transport closed`));
      producer.on('close', () => console.log(`${kind} producer closed`));

      cb({ id: producer.id });
    } catch (err) {
      console.error('produce error', err);
      cb({ error: err.message });
    }
  });

  // Viewer: create receive transport
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
    try {
      await socket.data.recvTransport.connect({ dtlsParameters });
      cb('ok');
    } catch (err) {
      console.error('connectRecvTransport error', err);
      cb({ error: err.message });
    }
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
    console.log('client disconnected', socket.id);
    try { socket.data.sendTransport?.close(); } catch {}
    try { socket.data.recvTransport?.close(); } catch {}
    const list = consumers.get(socket.id) || [];
    list.forEach(c => { try { c.close(); } catch {} });
    consumers.delete(socket.id);
  });
});
