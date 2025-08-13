import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3';

    const status = (t) => document.getElementById('status').textContent = t;
    const videoEl = document.getElementById('remote');

    const socket = io();            // same-origin Socket.IO
    let device;                     // mediasoup-client Device
    let recvTransport;              // receiving transport
    const mediaStream = new MediaStream(); // what we attach to <video>

    // Keep references to consumers so we can react to producer changes
    let videoConsumer = null;
    let audioConsumer = null;

    async function loadDevice() {
      const rtpCapabilities = await new Promise(res => socket.emit('getRtpCapabilities', res));
      device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities: rtpCapabilities });
    }

    function attachTrack(kind, track) {
      // Replace existing track of same kind
      if (kind === 'video') {
        const old = mediaStream.getVideoTracks()[0];
        if (old) mediaStream.removeTrack(old);
        mediaStream.addTrack(track);
      } else if (kind === 'audio') {
        const old = mediaStream.getAudioTracks()[0];
        if (old) mediaStream.removeTrack(old);
        mediaStream.addTrack(track);
      }
      // Make sure the video element has the stream
      if (!videoEl.srcObject) videoEl.srcObject = mediaStream;
    }

    async function createRecvTransport() {
      const params = await new Promise(res => socket.emit('createRecvTransport', res));
      if (params?.error) throw new Error(params.error);

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
    }

    async function consumeKind(kind) {
      const data = await new Promise(res => socket.emit('consume', {
        rtpCapabilities: device.rtpCapabilities,
        kind
      }, res));
      if (data?.error) {
        console.warn('consume error:', data.error);
        return null;
      }

      const consumer = await recvTransport.consume(data);
      // Attach track to our MediaStream
      attachTrack(kind, consumer.track);

      // Resume after we have the consumer
      await new Promise(res => socket.emit('resume', { consumerId: consumer.id }, res));

      // If broadcaster swaps to a new producer, this consumer's producer may close.
      // When that happens, re-consume the new one automatically.
      consumer.on('producerclose', async () => {
        try {
          status(`${kind} producer changed — updating…`);
          // Close old consumer cleanly
          try { consumer.close(); } catch {}
          // Pull the new producer/consumer for this kind
          await reconsume(kind);
          status('📺 Watching');
        } catch (e) {
          console.error('reconsume on producerclose failed:', e);
          status('Failed to update stream');
        }
      });

      return consumer;
    }

    async function reconsume(kind) {
      // Helper to (re)subscribe to the latest producer of given kind
      const data = await new Promise(res => socket.emit('consume', {
        rtpCapabilities: device.rtpCapabilities,
        kind
      }, res));
      if (data?.error) {
        console.warn('reconsume error:', data.error);
        return;
      }
      const newConsumer = await recvTransport.consume(data);
      attachTrack(kind, newConsumer.track);
      await new Promise(res => socket.emit('resume', { consumerId: newConsumer.id }, res));

      if (kind === 'video') {
        try { videoConsumer?.close(); } catch {}
        videoConsumer = newConsumer;
        videoConsumer.on('producerclose', () => reconsume('video').catch(console.error));
      } else {
        try { audioConsumer?.close(); } catch {}
        audioConsumer = newConsumer;
        audioConsumer.on('producerclose', () => reconsume('audio').catch(console.error));
      }
    }

    async function watch() {
      try {
        status('Loading device…');
        await loadDevice();

        status('Creating recv transport…');
        await createRecvTransport();

        status('Consuming video…');
        videoConsumer = await consumeKind('video');

        status('Consuming audio…');
        audioConsumer = await consumeKind('audio');

        status('📺 Watching');
      } catch (e) {
        console.error(e);
        status(e.message || 'Error starting viewer');
      }
    }

    // Optional: if your server emits this when broadcaster creates a new producer,
    // auto re-consume immediately (works in addition to the client-side fallback above).
    socket.on('newProducer', async ({ kind }) => {
      if (!device || !recvTransport) return; // not watching yet
      try { await reconsume(kind); } catch (e) { console.error('newProducer reconsume failed', e); }
    });

    document.getElementById('watch').onclick = watch;