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
        }
      } else if (kind === 'audio') {
        if (!track) return;
        if (audioProducer) {
          await audioProducer.replaceTrack({ track });
        } else {
          audioProducer = await sendTransport.produce({ track });
        }
      }
    }

    async function swapToStream(stream, label) {
      $local.srcObject = stream;

      status('Loading device…');
      await loadDevice();
      await ensureSendTransport();

      const v = stream.getVideoTracks()[0] || null;
      const a = stream.getAudioTracks()[0] || null;

      if (v) await produceOrReplace('video', v);
      if (a) await produceOrReplace('audio', a);

      if (currentStream && currentStream !== stream) stopStream(currentStream);
      currentStream = stream;

      status(label === 'screen' ? '🖥️ Sharing screen' : '🔴 Live (Camera)');
    }

    async function goLiveWithCamera() {
      status('Requesting camera/mic…');
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(e => {
        status('Failed to get camera/mic: ' + e.message + ' (use HTTPS)');
        throw e;
      });
      await swapToStream(stream, 'camera');
    }

    async function shareScreen() {
      status('Requesting screen…');
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).catch(e => {
        status('Failed to share screen: ' + e.message);
        throw e;
      });

      const screenVideo = stream.getVideoTracks()[0];
      if (screenVideo) {
        screenVideo.onended = async () => {
          status('Screen share ended. Switching back to camera…');
          try { await goLiveWithCamera(); } catch {}
        };
      }
      await swapToStream(stream, 'screen');
    }

    function stopBroadcast() {
      status('Stopping…');
      try { videoProducer?.close(); } catch {}
      try { audioProducer?.close(); } catch {}
      videoProducer = null;
      audioProducer = null;

      stopStream(currentStream);
      currentStream = null;
      $local.srcObject = null;

      status('Stopped');
    }

    document.getElementById('go').onclick = () => goLiveWithCamera().catch(err => { console.error(err); status(err.message); });
    document.getElementById('share').onclick = () => shareScreen().catch(err => { console.error(err); status(err.message); });
    document.getElementById('stop').onclick = () => stopBroadcast();