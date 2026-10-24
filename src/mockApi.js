// Simulated backend for running the UI in a browser without Electron.
// Downloads advance on a timer; nothing touches the network or disk.

const CATEGORY_BY_EXT = {
  zip: 'Compressed', rar: 'Compressed', '7z': 'Compressed', iso: 'Compressed',
  pdf: 'Documents', docx: 'Documents', xlsx: 'Documents', csv: 'Documents',
  mp3: 'Music', flac: 'Music', exe: 'Programs', msi: 'Programs',
  mp4: 'Video', mkv: 'Video', tif: 'Other',
};

function categoryOf(name) {
  return CATEGORY_BY_EXT[name.split('.').pop().toLowerCase()] || 'Other';
}

export function createMockApi() {
  const listeners = {
    update: new Set(),
    settings: new Set(),
    prompt: new Set(),
    auth: new Set(),
    pair: new Set(),
    pairClosed: new Set(),
    power: new Set(),
  };
  let settings = {
    downloadDir: 'C:\\Users\\you\\Downloads',
    categoryFolders: true,
    maxConcurrent: 3,
    connections: 8,
    speedLimitKBps: 0,
    clipboardMonitor: true,
    notifyOnComplete: true,
    apiPort: 6801,
    ffmpegPath: '',
    theme: 'system',
    accent: 'blue',
    density: 'comfortable',
    closeToTray: false,
    schedule: { enabled: true, startTime: '02:00', stopTime: '07:00', days: [1, 2, 3, 4, 5], afterDone: 'nothing' },
  };
  let seq = 0;
  const downloads = [];

  function make(url, { status = 'queued', total, done = 0, connections = 8, fileName } = {}) {
    const name = fileName || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
    const category = categoryOf(name);
    const totalBytes = total ?? Math.round((20 + Math.random() * 900) * 1024 * 1024);
    const segSize = Math.ceil(totalBytes / connections);
    const segments = Array.from({ length: connections }, (_, i) => {
      const start = i * segSize;
      const end = Math.min(totalBytes, (i + 1) * segSize) - 1;
      const share = Math.round((done / connections) * (0.6 + Math.random() * 0.8));
      return { start, end, downloaded: Math.min(end - start + 1, share), active: false };
    });
    const d = {
      id: `mock-${++seq}`,
      url,
      fileName: name,
      category,
      savePath: `${settings.downloadDir}\\${category}\\${name}`,
      totalBytes,
      downloadedBytes: 0,
      resumable: true,
      connections,
      segments,
      status,
      error: null,
      createdAt: Date.now() - Math.random() * 86400000 * 3,
      completedAt: null,
      speed: 0,
      eta: null,
      activeConnections: 0,
    };
    if (status === 'completed') {
      d.segments = [];
      d.downloadedBytes = totalBytes;
      d.completedAt = Date.now() - 3600000;
    } else {
      d.downloadedBytes = d.segments.reduce((s, x) => s + x.downloaded, 0);
    }
    downloads.push(d);
    return d;
  }

  make('https://download.osgeo.org/qgis/windows/QGIS-OSGeo4W-3.40.4-1.msi', { status: 'downloading', total: 1_180_000_000, done: 420_000_000 });
  make('https://example.org/data/sentinel2_T43QFV_20260412_B04.tif', { status: 'downloading', total: 125_000_000, done: 80_000_000 });
  make('https://example.org/datasets/srtm_dem_30m_india.zip', { status: 'paused', total: 2_400_000_000, done: 900_000_000 });
  make('https://example.org/papers/landsat9_oli2_handbook.pdf', { status: 'completed', total: 18_400_000 });
  make('https://example.org/media/lecture_remote_sensing_01.mp4', { status: 'completed', total: 742_000_000 });
  make('https://example.org/audio/podcast_ep42.mp3', { status: 'error', total: 64_000_000, done: 1_000_000 }).error = 'HTTP 403 Forbidden';
  make('https://example.org/tools/7z2409-x64.exe', { status: 'queued', total: 1_600_000 });
  make('ftp://ftp.example.org/pub/landsat/LC09_L2SP_144046_20260310.tar', { status: 'scheduled', total: 980_000_000, done: 0 });
  Object.assign(make('https://portal.example.org/secure/dem_tile_N28E077.zip', { status: 'auth-required', total: null, done: 0 }), {
    error: 'Login required: Data portal',
    segments: [],
  });
  const stream = make('https://cdn.example.org/lectures/gis-101/master.m3u8', {
    status: 'downloading',
    fileName: 'GIS 101 – Projections.mp4',
  });
  Object.assign(stream, {
    kind: 'hls',
    category: 'Video',
    segments: [],
    segmentsTotal: 412,
    segmentsDone: 150,
    sizeIsEstimate: true,
    streamInfo: { width: 1920, height: 1080, bandwidth: 5_200_000, tracks: [{ type: 'video', segments: 206 }, { type: 'audio', segments: 206 }] },
  });

  const emit = () => listeners.update.forEach((fn) => fn(downloads.map((d) => ({ ...d, segments: d.segments.map((s) => ({ ...s })) }))));

  function pump() {
    let running = downloads.filter((d) => d.status === 'downloading').length;
    for (const d of downloads) {
      if (running >= settings.maxConcurrent) break;
      if (d.status === 'queued') {
        d.status = 'downloading';
        running++;
      }
    }
  }

  setInterval(() => {
    for (const d of downloads) {
      if (d.status !== 'downloading') {
        d.speed = 0;
        d.eta = null;
        d.activeConnections = 0;
        d.segments.forEach((s) => (s.active = false));
        continue;
      }
      if (d.kind === 'hls') {
        d.segmentsDone = Math.min(d.segmentsTotal, d.segmentsDone + 2);
        d.downloadedBytes = d.segmentsDone * 1_400_000;
        d.totalBytes = d.segmentsTotal * 1_400_000;
        d.speed = 5_600_000;
        d.activeConnections = 8;
        d.eta = ((d.segmentsTotal - d.segmentsDone) / 4) * 1;
        d.pieces = Array.from({ length: 120 }, (_, i) => (i / 120 < d.segmentsDone / d.segmentsTotal ? 1 : 0));
        if (d.segmentsDone >= d.segmentsTotal) {
          d.status = 'completed';
          d.completedAt = Date.now();
        }
        continue;
      }
      let added = 0;
      for (const s of d.segments) {
        const left = s.end - s.start + 1 - s.downloaded;
        s.active = left > 0;
        const step = Math.min(left, Math.round((150 + Math.random() * 450) * 1024));
        s.downloaded += Math.max(0, step);
        added += Math.max(0, step);
      }
      d.downloadedBytes += added;
      d.speed = added * 2;
      d.activeConnections = d.segments.filter((s) => s.active).length;
      d.eta = d.speed ? (d.totalBytes - d.downloadedBytes) / d.speed : null;
      if (d.downloadedBytes >= d.totalBytes) {
        d.status = 'completed';
        d.completedAt = Date.now();
        d.segments = [];
      }
    }
    pump();
    emit();
  }, 500);

  const setStatus = (ids, status) => {
    for (const d of downloads) if (ids.includes(d.id) && d.status !== 'completed') d.status = status;
    pump();
    emit();
  };

  return {
    init: async () => ({
      downloads: downloads.map((d) => ({ ...d })),
      settings,
      categories: ['Compressed', 'Documents', 'Music', 'Programs', 'Video', 'Other'],
      version: 'preview',
    }),
    add: async ({ url, fileName, start = true }) => {
      const d = make(url, { status: start ? 'queued' : 'paused', done: 0, fileName });
      pump();
      emit();
      return d;
    },
    pause: async (ids) => setStatus(ids, 'paused'),
    resume: async (ids) => setStatus(ids, 'queued'),
    pauseAll: async () => setStatus(downloads.map((d) => d.id), 'paused'),
    resumeAll: async () => setStatus(downloads.filter((d) => d.status !== 'downloading').map((d) => d.id), 'queued'),
    remove: async (ids) => {
      for (const id of ids) downloads.splice(downloads.findIndex((d) => d.id === id), 1);
      emit();
    },
    setCredentials: async (id) => {
      const d = downloads.find((x) => x.id === id);
      Object.assign(d, { status: 'queued', error: null, hasLogin: true, totalBytes: 312_000_000 });
      d.segments = [{ start: 0, end: d.totalBytes - 1, downloaded: 0, active: false }];
      pump();
      emit();
    },
    schedule: async (ids) => setStatus(ids, 'scheduled'),
    runSchedule: async () => {
      const ids = downloads.filter((d) => d.status === 'scheduled').map((d) => d.id);
      setStatus(ids, 'queued');
      return ids.length;
    },
    cancelPowerAction: async () => listeners.power.forEach((fn) => fn(null)),
    respondPair: async (requestId) => listeners.pairClosed.forEach((fn) => fn(requestId)),
    pairings: async () => [{ id: 'p1', browser: 'Microsoft Edge', origin: 'chrome-extension://abc', createdAt: Date.now() - 86400000 }],
    revokePairing: async () => [],
    probe: async ({ url }) => {
      await new Promise((r) => setTimeout(r, 700));
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
      if (/secure|portal/.test(url)) return { url, kind: 'file', authRequired: true, realm: 'Data portal', error: 'Login required' };
      if (/youtube\.com\/playlist/.test(url)) {
        return {
          url,
          kind: 'site',
          site: 'YouTube',
          playlist: { title: 'Remote Sensing Basics', count: 4 },
          entries: ['Electromagnetic spectrum', 'Spectral signatures', 'Image classification', 'Accuracy assessment'].map((t, i) => ({
            url: `https://www.youtube.com/watch?v=rs10${i}`,
            title: `Lecture ${i + 1}: ${t}`,
            duration: 900 + i * 137,
          })),
        };
      }
      if (/youtube\.com|youtu\.be/.test(url)) {
        return {
          url,
          kind: 'site',
          site: 'YouTube',
          title: 'Introduction to Google Earth Engine: Sentinel-2 cloud masking',
          uploader: 'Geospatial Campus',
          duration: 1394,
          qualities: [2160, 1440, 1080, 720, 480, 360].map((height) => ({ height, bandwidth: height * 4200 })),
          category: 'Video',
        };
      }
      if (/\.m3u8$/.test(name)) {
        return {
          url,
          kind: 'hls',
          fileName: 'lecture.mp4',
          category: 'Video',
          qualities: [1080, 720, 480, 360].map((height, i) => ({ height, bandwidth: [5.2e6, 2.8e6, 1.4e6, 0.8e6][i] })),
          duration: 2843,
          segments: 474,
          separateAudio: true,
        };
      }
      return { url, kind: 'file', fileName: name, totalBytes: 734_003_200, resumable: true, category: categoryOf(name) };
    },
    platform: async () => 'win32',
    toolStatus: async () => ({ ytdlp: { path: 'yt-dlp.exe', version: '2026.10.21' }, ffmpeg: { path: 'ffmpeg.exe', version: 'ffmpeg version 7.1' }, canInstallFfmpeg: true }),
    installTool: async () => ({}),
    onToolProgress: () => () => {},
    setTitleBar: async () => {},
    checkFfmpeg: async () => ({ path: 'ffmpeg', version: 'ffmpeg version 7.1 (preview)' }),
    openExtensionFolder: async () => {},
    extensionFolder: async (browser) => `C:\\Program Files\\Anabranch\\resources\\browser-extension\\${browser}`,
    chooseFile: async () => 'C:\\ffmpeg\\bin\\ffmpeg.exe',
    removeCompleted: async () => {
      for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].status === 'completed') downloads.splice(i, 1);
      emit();
    },
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      listeners.settings.forEach((fn) => fn(settings));
      return settings;
    },
    openFile: async () => {},
    showInFolder: async () => {},
    openDownloadDir: async () => {},
    chooseDirectory: async () => 'D:\\Data\\Downloads',
    copy: async (text) => navigator.clipboard?.writeText(text).catch(() => {}),
    clipboardUrl: async () => '',
    apiInfo: async () => ({
      port: 6801,
      token: '3f9c1e0a7b5d42c88e61f0d2a9b7c4e1d5f6a8b9c0d1e2f3',
      url: 'http://127.0.0.1:6801',
      mcpScript: 'C:\\Program Files\\Anabranch\\resources\\mcp\\anabranch-mcp.cjs',
      executable: 'C:\\Program Files\\Anabranch\\Anabranch.exe',
    }),
    onUpdate: (fn) => (listeners.update.add(fn), () => listeners.update.delete(fn)),
    onSettings: (fn) => (listeners.settings.add(fn), () => listeners.settings.delete(fn)),
    onPromptAdd: (fn) => (listeners.prompt.add(fn), () => listeners.prompt.delete(fn)),
    onAuthRequired: (fn) => (listeners.auth.add(fn), () => listeners.auth.delete(fn)),
    onPairRequest: (fn) => (listeners.pair.add(fn), () => listeners.pair.delete(fn)),
    onPairClosed: (fn) => (listeners.pairClosed.add(fn), () => listeners.pairClosed.delete(fn)),
    onPowerCountdown: (fn) => (listeners.power.add(fn), () => listeners.power.delete(fn)),
    // Preview-only helpers to show the event-driven dialogs.
    simulatePairRequest: () => listeners.pair.forEach((fn) => fn({ requestId: 'r1', browser: 'Chrome', origin: 'chrome-extension://kfhlmnbcpdeogjaiab' })),
    simulatePowerCountdown: () => listeners.power.forEach((fn) => fn({ action: 'shutdown', seconds: 60 })),
    simulateBrowserPrompt: () =>
      listeners.prompt.forEach((fn) =>
        fn({ items: [{ url: 'https://cdn.example.org/vod/film/manifest.mpd', kind: 'dash', fileName: 'Field survey briefing', headers: { Cookie: 'sid=1', Referer: 'https://example.org/' } }] }),
      ),
  };
}
