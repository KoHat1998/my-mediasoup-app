import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

const status = (t) => document.getElementById('status').textContent = t;
const socket = io(); // connects to same origin (your HTTPS domain)
let device, sendTransport;

async function loadDevice() {
  const rtpCapabilities = await new Promise(res => socket.emit('getRtpCapabilities', res));
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });
}

async function start() {
  status('Requesting camera/mic…');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    status('Failed to get camera/mic: ' + e.message + ' (use HTTPS)');
    console.error(e);
    return;
  }
  document.getElementById('local').srcObject = stream;

  status('Loading device…');
  await loadDevice();

  status('Creating send transport…');
  const params = await new Promise(res => socket.emit('createSendTransport', res));
  if (params?.error) { status(params.error); return; }

  sendTransport = device.createSendTransport({
    id: params.id,
    iceParameters: params.iceParameters,
    iceCandidates: params.iceCandidates,
    dtlsParameters: params.dtlsParameters,
  });

  sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.emit('connectSendTransport', { dtlsParameters }, (r) =>
      r === 'ok' ? callback() : errback(new Error('connect failed'))
    );
  });

  sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
    socket.emit('produce', { kind, rtpParameters }, (data) => {
      if (data?.error) return errback(new Error(data.error));
      callback({ id: data.id });
    });
  });

  status('Producing tracks…');
  const v = stream.getVideoTracks()[0];
  if (v) await sendTransport.produce({ track: v });
  const a = stream.getAudioTracks()[0];
  if (a) await sendTransport.produce({ track: a });

  status('🔴 Live!');
}

document.getElementById('go').onclick = start;
