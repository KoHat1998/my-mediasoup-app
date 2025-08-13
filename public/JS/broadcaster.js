import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

const status = (t) => document.getElementById('status').textContent = t;
const $local = document.getElementById('local');
const $go = document.getElementById('go');
const $share = document.getElementById('share');
const $stop = document.getElementById('stop');

const socket = io(); // same origin
let device, sendTransport;
let currentStream = null;
let videoProducer = null;
let audioProducer = null;

async function loadDevice() {
  if (device) return;
  const rtpCapabilities = await new Promise(res => socket.emit('getRtpCapabilities', res));
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });
}

async function ensureSendTransport() {
  if (sendTransport) return;
  const params = await new Promise(res => socket.emit('createSendTransport', res));
  if (params?.error) throw new Error(params.error);

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
}

function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
}

async function produceOrReplace(kind, track) {
  if (kind === 'video') {
    if (videoProducer) {
      await videoProducer.replaceTrack({ track });
    } else {
      videoProducer = await sendTransport.produce({ track });
      videoProducer.on('trackended', () => status('Video track ended'));
    }
  } else if (kind === 'audio') {
    if (!track) return; // optional
    if (audioProducer) {
      await audioProducer.replaceTrack({ track });
    } else {
      audioProducer = await sendTransport.produce({ track });
      audioProducer.on('trackended', () => status('Audio track ended'));
    }
  }
}

async function goLiveWithCamera() {
  status('Requesting camera/mic…');
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(e => {
    status('Failed to get camera/mic: ' + e.message + ' (use HTTPS)');
    throw e;
  });

  swapToStream(stream, 'camera');
}

async function shareScreen() {
  status('Requesting screen…');
  // Note: audio:true lets Chrome capture tab/system audio (user must allow it).
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).catch(e => {
    status('Failed to share screen: ' + e.message);
    throw e;
  });

  // When user stops sharing via browser UI, revert to camera automatically.
  const screenVideo = stream.getVideoTracks()[0];
  if (screenVideo) {
    screenVideo.onended = async () => {
      status('Screen share ended. Switching back to camera…');
      try { await goLiveWithCamera(); } catch {}
    };
  }

  swapToStream(stream, 'screen');
}

async function swapToStream(stream, modeLabel) {
  // Preview locally
  $local.srcObject = stream;

  // Keep transport/producers
  status('Loading device…');
  await loadDevice();
  status('Creating send transport…');
  await ensureSendTransport();

  // Replace or produce tracks
  const v = stream.getVideoTracks()[0] || null;
  const a = stream.getAudioTracks()[0] || null;

  status(`Producing ${modeLabel} tracks…`);
  if (v) await produceOrReplace('video', v);

  // Audio rule:
  // - If the new stream has audio (mic or system audio), use it.
  // - If not, keep previous audioProducer as-is (e.g., continue mic audio while sharing screen with no system audio).
  if (a) {
    await produceOrReplace('audio', a);
  } else {
    // no new audio track; keep existing audioProducer (do nothing)
  }

  // Stop previously active stream (after replacing to avoid cutting out)
  if (currentStream && currentStream !== stream) stopStream(currentStream);
  currentStream = stream;

  status(modeLabel === 'screen' ? '🖥️ Sharing screen' : '🔴 Live (Camera)');
}

function stopBroadcast() {
  status('Stopping…');
  // Stop local media
  stopStream(currentStream);
  currentStream = null;
  $local.srcObject = null;

  // Stop producers (viewers will stop receiving)
  try { videoProducer?.close(); } catch {}
  try { audioProducer?.close(); } catch {}
  videoProducer = null;
  audioProducer = null;

  status('Stopped');
}

$go.onclick = () => goLiveWithCamera().catch(console.error);
$share.onclick = () => shareScreen().catch(console.error);
$stop.onclick = () => stopBroadcast();
