import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

const status = (t) => document.getElementById('status').textContent = t;
const socket = io();
let device, recvTransport, mediaStream = new MediaStream();

async function loadDevice() {
  const rtpCapabilities = await new Promise(res => socket.emit('getRtpCapabilities', res));
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });
}

async function consumeKind(kind) {
  const data = await new Promise(res => socket.emit('consume', {
    rtpCapabilities: device.rtpCapabilities, kind
  }, res));
  if (data?.error) { console.warn(data.error); return null; }
  const consumer = await recvTransport.consume(data);
  mediaStream.addTrack(consumer.track);
  await new Promise(res => socket.emit('resume', { consumerId: consumer.id }, res));
  return consumer;
}

async function watch() {
  status('Loading device…');
  await loadDevice();

  status('Creating recv transport…');
  const params = await new Promise(res => socket.emit('createRecvTransport', res));
  if (params?.error) { status(params.error); return; }

  recvTransport = device.createRecvTransport({
    id: params.id,
    iceParameters: params.iceParameters,
    iceCandidates: params.iceCandidates,
    dtlsParameters: params.dtlsParameters
  });

  recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.emit('connectRecvTransport', { dtlsParameters }, (r) =>
      r === 'ok' ? callback() : errback(new Error('connect failed'))
    );
  });

  status('Consuming video…');
  await consumeKind('video');
  status('Consuming audio…');
  await consumeKind('audio');

  document.getElementById('remote').srcObject = mediaStream;
  status('📺 Watching');
}

document.getElementById('watch').onclick = watch;
