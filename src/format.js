const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export const formatSpeed = (bps) => (bps ? `${formatBytes(bps)}/s` : '');

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s} sec`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} sec`;
  const h = Math.floor(s / 3600);
  return `${h} h ${Math.floor((s % 3600) / 60)} min`;
}

export function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function percent(d) {
  if (d.status === 'completed') return 100;
  // Streams count finished segments; their byte total is only an estimate.
  if (d.kind && d.kind !== 'file') return d.segmentsTotal ? (d.segmentsDone / d.segmentsTotal) * 100 : null;
  if (!d.totalBytes) return null;
  return Math.min(100, (d.downloadedBytes / d.totalBytes) * 100);
}

export const formatSize = (d) => `${d.sizeIsEstimate ? '~' : ''}${formatBytes(d.totalBytes)}`;

export const KIND_LABELS = { hls: 'HLS', dash: 'DASH' };

export function protocolLabel(d) {
  if (KIND_LABELS[d.kind]) return KIND_LABELS[d.kind];
  return /^ftps?:/i.test(d.url) ? 'FTP' : null;
}

export const STATUS_LABELS = {
  queued: 'Queued',
  scheduled: 'Scheduled',
  connecting: 'Connecting…',
  downloading: 'Downloading',
  merging: 'Merging…',
  paused: 'Stopped',
  completed: 'Complete',
  error: 'Error',
  'auth-required': 'Login required',
};

export const ACTIVE = new Set(['connecting', 'downloading', 'merging']);

export function statusText(d) {
  if (d.status === 'downloading') {
    const p = percent(d);
    return p == null ? formatBytes(d.downloadedBytes) : `${p.toFixed(1)}%`;
  }
  const p = percent(d);
  if ((d.status === 'paused' || d.status === 'scheduled') && d.downloadedBytes > 0 && p != null) {
    return `${STATUS_LABELS[d.status]} · ${p.toFixed(0)}%`;
  }
  return STATUS_LABELS[d.status] || d.status;
}

export function formatRelative(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function formatClock(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// One line describing where a download stands, used under its name.
export function describe(d, schedule) {
  const of = `${formatBytes(d.downloadedBytes)} of ${formatSize(d)}`;
  const p = percent(d);
  switch (d.status) {
    case 'downloading':
      return [p != null ? `${p.toFixed(p < 10 ? 1 : 0)}%` : formatBytes(d.downloadedBytes), formatSpeed(d.speed), d.eta != null ? `${formatDuration(d.eta)} left` : '', d.totalBytes ? of : '']
        .filter(Boolean)
        .join(' · ');
    case 'connecting':
      return 'Connecting…';
    case 'merging':
      return 'Merging audio and video…';
    case 'queued':
      return `Waiting in queue${d.totalBytes ? ` · ${formatSize(d)}` : ''}`;
    case 'scheduled':
      return schedule?.enabled ? `Starts at ${schedule.startTime}` : 'In the scheduled queue';
    case 'paused':
      return d.downloadedBytes ? `Paused · ${of}` : 'Paused';
    case 'error':
      return d.error || 'Failed';
    case 'auth-required':
      return 'Sign-in required';
    case 'completed':
      return [formatSize(d), formatRelative(d.completedAt)].filter(Boolean).join(' · ');
    default:
      return '';
  }
}
