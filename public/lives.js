// public/lives.js
(() => {
  'use strict';

  // -------- Auth guard --------
  const rawToken =
    localStorage.getItem('token') ||
    localStorage.getItem('authToken') ||
    '';
  if (!rawToken) {
    location.replace('/signin.html');
    return;
  }
  const AUTH = /^Bearer\s/i.test(rawToken) ? rawToken : `Bearer ${rawToken}`;

  // -------- DOM refs --------
  const listEl  = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const hintEl  = document.getElementById('hint');

  const userEmail = document.getElementById('userEmail');
  const email =
    (JSON.parse(localStorage.getItem('user') || '{}').email) ||
    localStorage.getItem('email') ||
    '';
  if (email) userEmail.textContent = email;

  document.getElementById('signout').onclick = () => {
    localStorage.clear();
    location.replace('/signin.html');
  };

  // Optional controls from lives.html (safe if not present)
  const searchInput = document.getElementById('search');
  const sortSelect  = document.getElementById('sort');

  // -------- State --------
  let livesData = [];       // raw items from API
  let filterText = '';      // simple text filter
  let sortMode = 'recent';  // 'recent' | 'title'

  // -------- Helpers --------
  const escapeHtml = (s = '') =>
    s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const fmtDate = (iso) => {
    try { return new Date(iso).toLocaleString(); }
    catch { return iso || ''; }
  };

  const liveTile = (l) => {
    const title = escapeHtml(l.title || 'Untitled Live');
    const started = fmtDate(l.createdAt);
    const watchUrl = `/viewer.html?slug=${encodeURIComponent(l.slug)}`;
    const copyFn = `copySlug('${encodeURIComponent(l.slug)}')`;
    return `
      <div class="tile">
        <div class="badges"><span class="badge live">LIVE</span></div>
        <h3 class="title" title="${title}">${title}</h3>
        <p class="meta">Started ${escapeHtml(started)}</p>
        <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap">
          <a class="btn ghost" href="${watchUrl}">Watch</a>
          <button class="btn link" onclick="${copyFn}">Copy link</button>
        </div>
      </div>
    `;
  };

  const applyFilterSort = (items) => {
    let arr = Array.isArray(items) ? items.slice() : [];
    const q = filterText.trim().toLowerCase();

    if (q) {
      arr = arr.filter((x) =>
        (x.title || '').toLowerCase().includes(q) ||
        (x.slug || '').toLowerCase().includes(q)
      );
    }

    if (sortMode === 'title') {
      arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    } else {
      // recent first
      arr.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    }
    return arr;
  };

  const render = () => {
    const arr = applyFilterSort(livesData);

    if (!arr.length) {
      if (listEl) listEl.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
      if (hintEl) hintEl.textContent = 'Browse streams or start your own.';
      // If lives.html provided a hook, inform it
      window.livenixSetVisibility?.(false);
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (hintEl) hintEl.textContent = 'Browse streams or start your own.';
    if (listEl) listEl.innerHTML = arr.map(liveTile).join('');
    window.livenixSetVisibility?.(true);
  };

  // -------- API calls --------
  async function loadLives() {
    if (hintEl) hintEl.textContent = 'Loading…';
    if (emptyEl) emptyEl.style.display = 'none';
    if (listEl) listEl.innerHTML = '';

    try {
      const r = await fetch('/api/lives', {
        headers: { 'Authorization': AUTH }
      });

      if (r.status === 401) {
        location.replace('/signin.html');
        return;
      }

      const data = await r.json();
      livesData = Array.isArray(data) ? data : [];
      render();
    } catch (e) {
      console.error(e);
      livesData = [];
      render();
      if (emptyEl) {
        emptyEl.style.display = 'block';
        emptyEl.textContent = 'Failed to load lives. Please try again.';
      }
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
          'Authorization': AUTH
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

  // -------- Copy helpers (global for onclick) --------
  window.copySlug = (slugEnc) => {
    const slug = decodeURIComponent(slugEnc);
    const url = `${location.origin}/viewer.html?slug=${slug}`;
    navigator.clipboard?.writeText(url).then(
      () => alert('Link copied:\n' + url),
      () => alert('Copy failed. Link:\n' + url)
    );
  };

  // -------- Wire buttons --------
  document.getElementById('create').onclick = createLive;
  document.getElementById('refresh').onclick = loadLives;
  document.getElementById('linkGoLive').onclick = (e) => { e.preventDefault(); createLive(); };

  // -------- Optional: search/sort hooks --------
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      filterText = searchInput.value || '';
      render();
    });
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      sortMode = sortSelect.value || 'recent';
      render();
    });
  }

  // Expose hooks (used by the inline script in lives.html; safe if unused)
  window.livenixFilter = (text) => { filterText = text || ''; render(); };
  window.livenixSort   = (mode) => { sortMode = mode || 'recent'; render(); };

  // -------- Initial load --------
  loadLives();
})();