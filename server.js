// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();
app.use(express.static('public')); // we'll put simple HTML/JS in /public

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const ANNOUNCED_IP = '13.210.150.18'; // <-- change this
const WEBRTC_MIN_PORT = 40000;
const WEBRTC_MAX_PORT = 49999;

let worker;
let router;
let producer = null; // we allow one broadcaster at a time for simplicity
const consumers = new Map(); // socket.id -> [consumer, ...]

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
];

(async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: WEBRTC_MIN_PORT,
    rtcMaxPort: WEBRTC_MAX_PORT
  });
  router = await worker.createRouter({ mediaCodecs });
  console.log('Mediasoup worker+router ready');

  server.listen(PORT, () => console.log(`Server on http://0.0.0.0:${PORT}`));
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

  socket.on('getRtpCapabilities', async (cb) => {
    cb(router.rtpCapabilities);
  });

  // Broadcaster creates a send transport
  socket.on('createSendTransport', async (cb) => {
    const transport = await createWebRtcTransport();
    socket.data.sendTransport = transport;
    cb({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });
  });

  socket.on('connectSendTransport', async ({ dtlsParameters }, cb) => {
    await socket.data.sendTransport.connect({ dtlsParameters });
    cb('ok');
  });

  socket.on('produce', async ({ kind, rtpParameters }, cb) => {
    if (!socket.data.sendTransport) return cb({ error: 'no transport' });
    // only one producer (video+audio tracks are two producers but from one socket)
    const p = await socket.data.sendTransport.produce({ kind, rtpParameters });
    // store video producer as the “broadcast” (simple rule: prefer video)
    if (kind === 'video') producer = p;
    p.on('transportclose', () => console.log('producer transport closed'));
    cb({ id: p.id });
  });

  // Viewer creates a recv transport and consumes
  socket.on('createRecvTransport', async (cb) => {
    const transport = await createWebRtcTransport();
    socket.data.recvTransport = transport;
    cb({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });
  });

  socket.on('connectRecvTransport', async ({ dtlsParameters }, cb) => {
    await socket.data.recvTransport.connect({ dtlsParameters });
    cb('ok');
  });

  socket.on('consume', async ({ rtpCapabilities, kind }, cb) => {
    try {
      // Find a producer of the requested kind (we keep the most recent video as “broadcast”)
      let targetProducer = producer;
      // NOTE: for audio you might also want to store an audio producer; keeping it simple here.
      if (!targetProducer || targetProducer.kind !== kind) {
        // no producer of that kind
        return cb({ error: 'no producer' });
      }
      if (!router.canConsume({ producerId: targetProducer.id, rtpCapabilities })) {
        return cb({ error: 'cannot consume' });
      }
      const consumer = await socket.data.recvTransport.consume({
        producerId: targetProducer.id,
        rtpCapabilities,
        paused: true
      });
      // keep track to close later
      const list = consumers.get(socket.id) || [];
      list.push(consumer);
      consumers.set(socket.id, list);

      consumer.on('transportclose', () => console.log('consumer transport closed'));
      consumer.on('producerclose', () => console.log('producer closed'));

      cb({
        id: consumer.id,
        producerId: targetProducer.id,
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
    // cleanup
    if (socket.data.sendTransport) socket.data.sendTransport.close();
    if (socket.data.recvTransport) socket.data.recvTransport.close();
    const list = consumers.get(socket.id) || [];
    list.forEach(c => c.close());
    consumers.delete(socket.id);
  });
});
