// public/lives.js
(() => {
  'use strict';

  // -------- Auth guard --------
  const token =
    localStorage.getItem('token') ||
    localStorage.getItem('authToken') ||
    '';

  if (!token) {
    location.replace('/signin.html');
    return;
  }

  // -------- DOM refs --------
  const listEl  = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const hintEl  = document.getElementById('hint');

  // Header UI
  const email =
    (JSON.parse(localStorage.getItem('user') || '{}').email) ||
    localStorage.getItem('email') ||
    '';
  const userEmail = document.getElementById('userEmail');
  if (email) userEmail.textContent = email;

  document.getElementById('signout').onclick = () => {
    localStorage.clear();
    location.replace('/signin.html');
  };

  // -------- Helpers --------
  function escapeHtml(s = '') {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function liveTile(l) {
    const title = escapeHtml(l.title || 'Untitled Live');
    const started = new Date(l.createdAt).toLocaleString();
    const watchUrl = `/viewer.html?slug=${encodeURIComponent(l.slug)}`;
    const copyFn = `copySlug('${encodeURIComponent(l.slug)}')`;
    return `
      <div class="tile">
        <div class="badges"><span class="badge live">LIVE</span></div>
        <h3 class="title">${title}</h3>
        <p class="meta">Started ${started}</p>
        <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap">
          <a class="btn ghost" href="${watchUrl}">Watch</a>
          <button class="btn link" onclick="${copyFn}">Copy link</button>
        </div>
      </div>
    `;
  }

  async function loadLives() {
    listEl.innerHTML = '';
    emptyEl.style.display = 'none';
    if (hintEl) hintEl.textContent = 'Loading…';

    try {
      const r = await fetch('/api/lives', {
        headers: { 'Authorization': token }
      });

      if (r.status === 401) {
        location.replace('/signin.html');
        return;
      }

      const lives = await r.json();

      if (!Array.isArray(lives) || lives.length === 0) {
        emptyEl.style.display = 'block';
        if (hintEl) hintEl.textContent = 'Browse streams or start your own.';
        return;
      }

      listEl.innerHTML = lives.map(liveTile).join('');
      if (hintEl) hintEl.textContent = 'Browse streams or start your own.';
    } catch (e) {
      emptyEl.style.display = 'block';
      emptyEl.textContent = 'Failed to load lives. Please try again.';
      console.error(e);
      if (hintEl) hintEl.textContent = 'Error loading.';
    }
  }

  async function createLive() {
    const title = prompt('Live title?') || 'My Live';
    try {
      const r = await fetch('/api/lives', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token
        },
        body: JSON.stringify({ title })
      });

      if (r.status === 401) {
        location.replace('/signin.html');
        return;
      }

      const live = await r.json();
      if (!r.ok || !live?.id) {
        throw new Error(live?.error || 'Failed to create live');
      }

      // Navigate to broadcaster console with live id
      location.href = '/broadcast.html?id=' + encodeURIComponent(live.id);
    } catch (e) {
      alert(e.message || 'Failed to create live');
    }
  }

  // Copy helpers (global so onclick can access)
  window.copySlug = (slugEnc) => {
    const slug = decodeURIComponent(slugEnc);
    const url = `${location.origin}/viewer.html?slug=${slug}`;
    navigator.clipboard?.writeText(url).then(
      () => alert('Link copied:\n' + url),
      () => alert('Copy failed. Link:\n' + url)
    );
  };

  // Wire buttons
  document.getElementById('create').onclick = createLive;
  document.getElementById('refresh').onclick = loadLives;
  document.getElementById('linkGoLive').onclick = (e) => { e.preventDefault(); createLive(); };

  // Initial load
  loadLives();
})();