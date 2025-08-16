/*!
 * KoHat Live - embed.js (viewer SDK)
 * Exposes a global start({host, channelId}) returning a player-like object:
 *   { attach(video), setQuality(level), on(ev,fn), stop() }
 * Events:
 *   'live'        -> boolean
 *   'resolution'  -> number (height in pixels, e.g., 720)
 *   'viewerCount' -> number
 *   'network'     -> { kbps, plr }
 */
(function () {
  const QUALITY_MAP = { low: 0, med: 1, high: 2 };
  const TARGET_P = { low: 360, med: 540, high: 720 };

  // Utils
  function once(fn) { let ran=false, val; return async (...a)=>{ if(!ran){ ran=true; val=await fn(...a);} return val; }; }
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

  async function ensureSocketIO(host) {
    if ('io' in window) return;
    // load from your server to ensure version match
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${host.replace(/\/$/,'')}/socket.io/socket.io.js`;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load Socket.IO client'));
      document.head.appendChild(s);
    });
    // tiny wait in case window.io attaches late
    for (let i = 0; i < 10 && !('io' in window); i++) await sleep(30);
    if (!('io' in window)) throw new Error('Socket.IO client not available');
  }

  const loadMediasoup = once(async () => {
    const m = await import('https://esm.sh/mediasoup-client@3');
    return m.Device;
  });

  // Event hub for player instance
  class Emitter {
    constructor(){ this.map = new Map(); }
    on(ev, fn){ if(!this.map.has(ev)) this.map.set(ev, new Set()); this.map.get(ev).add(fn); return ()=>this.off(ev, fn); }
    off(ev, fn){ const s=this.map.get(ev); if(s) s.delete(fn); }
    emit(ev, payload){ const s=this.map.get(ev); if(s) for(const fn of s) { try{ fn(payload); }catch(e){ console.error(e); } } }
  }

  async function startImpl({ host, channelId }) {
    if (!host) throw new Error('host is required');
    if (!channelId) throw new Error('channelId is required (b1 or b2)');
    const base = host.replace(/\/$/, '');

    await ensureSocketIO(base);
    const Device = await loadMediasoup();

    // Socket
    const socket = window.io(base, { transports: ['websocket','polling'] });

    // Helper to emit with ack
    const ack = (event, payload) => new Promise(res => socket.emit(event, payload, res));

    // Join room (for viewerCount + newProducer events)
    await ack('join', { channelId });

    // Forward viewerCount to consumer
    const em = new Emitter();
    socket.on('viewerCount', ({ count }) => em.emit('viewerCount', count));

    // mediasoup device
    const routerCaps = await ack('getRtpCapabilities');
    const device = new Device();
    await device.load({ routerRtpCapabilities: routerCaps });

    // recv transport
    const tpParams = await ack('createRecvTransport', { channelId });
    if (tpParams?.error) throw new Error(tpParams.error);
    const recvTransport = device.createRecvTransport(tpParams);
    recvTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
      ack('connectRecvTransport', { channelId, dtlsParameters }).then(r => r === 'ok' ? cb() : eb(new Error('connect failed')));
    });

    // Consume helper
    async function consume(kind) {
      const data = await ack('consume', { channelId, rtpCapabilities: device.rtpCapabilities, kind });
      if (data?.error) {
        if (kind === 'video') em.emit('live', false);
        return null;
      }
      const consumer = await recvTransport.consume(data);
      await ack('resume', { consumerId: consumer.id });
      return consumer;
    }

    // Start consuming
    let videoConsumer = await consume('video');
    let audioConsumer = await consume('audio');

    // React when broadcaster (re)produces
    socket.on('newProducer', async ({ channelId: cid, kind }) => {
      if (cid !== channelId) return;
      try {
        const data = await ack('consume', { channelId, rtpCapabilities: device.rtpCapabilities, kind });
        if (data?.error) return;
        const c = await recvTransport.consume(data);
        await ack('resume', { consumerId: c.id });
        if (kind === 'video') { try{ videoConsumer?.close(); }catch{} videoConsumer = c; em.emit('live', true); }
        else { try{ audioConsumer?.close(); }catch{} audioConsumer = c; }
      } catch (e) { console.error('[reconsume]', e); }
    });

    // Build MediaStream
    const mediaStream = new MediaStream();
    const attachTrack = (kind, track) => {
      if (kind === 'video') {
        const old = mediaStream.getVideoTracks()[0];
        if (old) mediaStream.removeTrack(old);
        mediaStream.addTrack(track);
      } else {
        const old = mediaStream.getAudioTracks()[0];
        if (old) mediaStream.removeTrack(old);
        mediaStream.addTrack(track);
      }
    };
    if (videoConsumer) attachTrack('video', videoConsumer.track);
    if (audioConsumer) attachTrack('audio', audioConsumer.track);

    // Live state
    em.emit('live', !!videoConsumer);

    // Stats loop for resolution + network
    let statsTimer = null;
    function startStats() {
      if (statsTimer) clearInterval(statsTimer);
      let lastBytes = 0, lastTs = 0;
      statsTimer = setInterval(async () => {
        try {
          if (!videoConsumer) return;
          const stats = await videoConsumer.getStats();
          let bytes=0, ts=0, pl=0, pr=0, w=0, h=0;

          stats.forEach(s => {
            if (s.type === 'inbound-rtp' && !s.isRemote) {
              bytes = s.bytesReceived || bytes;
              ts = s.timestamp || ts;
              pl = s.packetsLost || pl;
              pr = s.packetsReceived || pr;
              if (typeof s.frameWidth === 'number')  w = s.frameWidth;
              if (typeof s.frameHeight === 'number') h = s.frameHeight;
            }
            if (s.type === 'track' && s.kind === 'video') {
              if (typeof s.frameWidth === 'number')  w = s.frameWidth || w;
              if (typeof s.frameHeight === 'number') h = s.frameHeight || h;
            }
          });

          if (h) em.emit('resolution', h);
          if (ts && lastTs && bytes >= lastBytes) {
            const kbps = ((bytes - lastBytes) * 8) / ((ts - lastTs) / 1000) / 1000;
            const plr = pr > 0 ? (pl / (pr + pl)) * 100 : 0;
            em.emit('network', { kbps: Math.round(kbps), plr: +plr.toFixed(2) });
          }
          lastBytes = bytes; lastTs = ts;
        } catch {}
      }, 2000);
    }
    if (videoConsumer) startStats();

    // Public API (what your friend expects)
    const api = {
      attach(videoEl) {
        if (!videoEl) return;
        // Ensure the element gets our stream (and autoplay)
        videoEl.srcObject = mediaStream;
        if (typeof videoEl.play === 'function') { videoEl.play().catch(()=>{}); }
      },
      setQuality(level) {
        if (level === 'auto') return; // let CC adapt
        if (!videoConsumer) return;
        const spatialLayer = QUALITY_MAP[level] ?? 2;
        // optimistic hint (send requested height)
        if (TARGET_P[level]) em.emit('resolution', TARGET_P[level]);
        return ack('setPreferredLayers', { channelId, spatialLayer });
      },
      on(ev, handler) { return em.on(ev, handler); },
      stop() {
        try {
          if (statsTimer) clearInterval(statsTimer);
          statsTimer = null;
          try { videoConsumer?.close(); } catch {}
          try { audioConsumer?.close(); } catch {}
          // detach media from any attached element
          const videos = document.getElementsByTagName('video');
          for (const v of videos) { if (v.srcObject === mediaStream) { v.pause?.(); v.srcObject = null; } }
        } catch {}
      }
    };

    return api;
  }

  // Expose a global function that returns the player API object
  window.start = function ({ host, channelId }) {
    return startImpl({ host, channelId });
  };
})();
