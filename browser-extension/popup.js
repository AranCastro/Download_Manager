const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function send(msg) {
  const reply = await ext.runtime.sendMessage(msg);
  if (reply?.error) throw new Error(reply.error);
  return reply;
}

const KIND_LABEL = { hls: 'HLS', dash: 'DASH', file: 'File' };

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function showError(err) {
  $('error').textContent = err ? err.message || String(err) : '';
  $('error').hidden = !err;
}

function showState(status) {
  for (const id of ['offline', 'unpaired', 'connected']) $(id).hidden = id !== status;
  const label = { offline: 'Not running', unpaired: 'Not connected', connected: 'Connected' }[status];
  $('status').textContent = label;
  $('status').className = `status status-${status}`;
}

// popup.html?tab=<id> shows another tab's media (used when the panel is
// opened as a page, e.g. in automated tests).
async function activeTab() {
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  if (forced) return ext.tabs.get(forced);
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// A file name for a stream: the page title, which is what users recognise.
function nameFor(entry, tab) {
  if (entry.kind === 'file') return undefined;
  const title = (tab?.title || '')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[\\/*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return title.slice(0, 120) || undefined;
}

/* youtube:start */
const isYouTubeVideo = (url) => {
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/.test(u.hostname) && ((u.pathname === '/watch' && u.searchParams.has('v')) || u.pathname.startsWith('/shorts/'));
  } catch {
    return false;
  }
};

// On a YouTube video the page itself is offered: the app picks the quality
// and downloads it with yt-dlp.
function renderPageVideo(tab) {
  const show = isYouTubeVideo(tab?.url);
  $('page-video').hidden = !show;
  if (!show) return;
  $('page-video-title').textContent = (tab.title || '').replace(/\s*-\s*YouTube$/, '') || tab.url;
  const button = $('page-video-download');
  button.onclick = async () => {
    button.disabled = true;
    try {
      await send({ type: 'download-page', url: tab.url, storeId: tab.cookieStoreId });
      button.textContent = 'Sent to Anabranch';
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  };
}
/* youtube:end */

async function renderMedia() {
  const tab = await activeTab();
  let pageVideo = false;
  /* youtube:start */
  pageVideo = isYouTubeVideo(tab.url);
  renderPageVideo(tab);
  /* youtube:end */
  const { media } = await send({ type: 'media', tabId: tab.id });
  const list = $('media');
  list.replaceChildren();
  $('no-media').hidden = media.length > 0 || pageVideo;
  $('media-heading').hidden = !media.length && pageVideo;
  for (const entry of media) {
    const li = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = `kind kind-${entry.kind}`;
    badge.textContent = KIND_LABEL[entry.kind];
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('strong');
    let file = entry.url;
    try {
      file = decodeURIComponent(new URL(entry.url).pathname.split('/').pop()) || entry.url;
    } catch {
      // keep the URL
    }
    name.textContent = entry.kind === 'file' ? file : tab.title || file;
    name.title = entry.url;
    const meta = document.createElement('small');
    // A playlist's own size says nothing about the video, so only files show one.
    const size = entry.kind === 'file' ? formatBytes(entry.size) : '';
    meta.textContent = [entry.label, size, entry.kind !== 'file' ? file : ''].filter(Boolean).join(' · ');
    info.append(name, meta);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Download';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await send({
          type: 'download-media',
          url: entry.url,
          kind: entry.kind,
          fileName: nameFor(entry, tab),
          pageUrl: tab.url,
          storeId: tab.cookieStoreId,
        });
        button.textContent = 'Sent';
      } catch (err) {
        button.disabled = false;
        showError(err);
      }
    });
    li.append(badge, info, button);
    list.append(li);
  }
}

async function refresh() {
  showError(null);
  try {
    const { status, settings } = await send({ type: 'status' });
    showState(status);
    for (const key of ['capture', 'confirm']) $(key).checked = Boolean(settings[key]);
    for (const key of ['types', 'minSizeKB', 'skipHosts']) $(key).value = settings[key];
    if (status === 'connected') await renderMedia();
  } catch (err) {
    showError(err);
  }
}

$('retry').addEventListener('click', refresh);

$('pair').addEventListener('click', async () => {
  $('pair').disabled = true;
  $('pair-note').hidden = false;
  try {
    await send({ type: 'pair' });
    await refresh();
  } catch (err) {
    showError(err);
  } finally {
    $('pair').disabled = false;
    $('pair-note').hidden = true;
  }
});

$('save').addEventListener('click', async () => {
  await send({
    type: 'save-settings',
    settings: {
      capture: $('capture').checked,
      confirm: $('confirm').checked,
      types: $('types').value,
      minSizeKB: Math.max(0, Number($('minSizeKB').value) || 0),
      skipHosts: $('skipHosts').value,
    },
  });
  $('saved').hidden = false;
  setTimeout(() => ($('saved').hidden = true), 1500);
});

$('disconnect').addEventListener('click', async () => {
  await send({ type: 'disconnect' });
  refresh();
});

refresh();
