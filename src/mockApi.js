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
  const listeners = { update: new Set(), settings: new Set(), prompt: new Set() };
  let settings = {
    downloadDir: 'C:\\Users\\you\\Downloads',
    categoryFolders: true,
    maxConcurrent: 3,
    connections: 8,
    speedLimitKBps: 0,
    clipboardMonitor: true,
    notifyOnComplete: true,
    apiPort: 6801,
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
      mcpScript: 'C:\\Program Files\\Download Manager\\resources\\mcp\\download-manager-mcp.cjs',
      executable: 'C:\\Program Files\\Download Manager\\Download Manager.exe',
    }),
    onUpdate: (fn) => (listeners.update.add(fn), () => listeners.update.delete(fn)),
    onSettings: (fn) => (listeners.settings.add(fn), () => listeners.settings.delete(fn)),
    onPromptAdd: (fn) => (listeners.prompt.add(fn), () => listeners.prompt.delete(fn)),
  };
}
