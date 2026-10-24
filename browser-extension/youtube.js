// Adds a "Download" button over the YouTube player that sends the video to
// Anabranch (with the browser's YouTube sign-in, so signed-in and
// age-restricted videos work). The button lives in a shadow root so the
// page's styles cannot reach it.
(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const ID = 'anabranch-download-button';

  function videoUrl() {
    const u = new URL(location.href);
    const id = u.searchParams.get('v');
    if (u.pathname === '/watch' && id) return `https://www.youtube.com/watch?v=${id}`;
    const short = /^\/shorts\/([\w-]{6,})/.exec(u.pathname);
    return short ? `https://www.youtube.com/shorts/${short[1]}` : null;
  }

  function findPlayer() {
    return document.querySelector('#movie_player') || document.querySelector('ytd-reel-video-renderer[is-active] #player-container');
  }

  function build() {
    const host = document.createElement('div');
    host.id = ID;
    host.style.cssText = 'position:absolute;top:12px;right:12px;z-index:70;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        button { display:flex; align-items:center; gap:6px; padding:8px 13px; border:0; border-radius:18px;
          background:rgba(20,22,27,.84); color:#fff; font:600 13px/1 Roboto, Arial, sans-serif; cursor:pointer;
          box-shadow:0 2px 10px rgba(0,0,0,.35); opacity:0; transform:translateY(-4px);
          transition:opacity .18s, transform .18s, background .18s; }
        :host(.show) button, button:focus-visible { opacity:1; transform:none; }
        button:hover { background:#2563eb; }
        svg { width:16px; height:16px; }
      </style>
      <button type="button" title="Download with Anabranch" aria-label="Download with Anabranch">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>
        </svg>
        <span>Download</span>
      </button>`;
    const button = root.querySelector('button');
    const label = root.querySelector('span');
    // Keep clicks from reaching the player (which would pause or play it).
    for (const type of ['pointerdown', 'mousedown', 'dblclick']) button.addEventListener(type, (e) => e.stopPropagation());
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      label.textContent = 'Sending…';
      try {
        const reply = await ext.runtime.sendMessage({ type: 'download-page', url: videoUrl() });
        label.textContent = reply?.error ? 'Connect Anabranch first' : 'Sent to Anabranch';
      } catch {
        label.textContent = 'Connect Anabranch first';
      }
      host.classList.add('show');
      setTimeout(() => (label.textContent = 'Download'), 2600);
    });
    return host;
  }

  function mount() {
    const player = findPlayer();
    const existing = document.getElementById(ID);
    if (!videoUrl() || !player) {
      existing?.remove();
      return;
    }
    if (existing?.parentElement === player) return;
    existing?.remove();
    const host = build();
    player.appendChild(host);
    if (!player.dataset.anabranchHover) {
      player.dataset.anabranchHover = '1';
      player.addEventListener('mouseenter', () => document.getElementById(ID)?.classList.add('show'));
      player.addEventListener('mouseleave', () => document.getElementById(ID)?.classList.remove('show'));
    }
  }

  // YouTube is a single-page app: re-check after its own navigations and
  // whenever the player is rebuilt.
  document.addEventListener('yt-navigate-finish', mount);
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      mount();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  mount();
})();
