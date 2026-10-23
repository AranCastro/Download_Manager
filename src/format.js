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
  if (!d.totalBytes) return null;
  return Math.min(100, (d.downloadedBytes / d.totalBytes) * 100);
}

export const STATUS_LABELS = {
  queued: 'Queued',
  connecting: 'Connecting…',
  downloading: 'Downloading',
  paused: 'Stopped',
  completed: 'Complete',
  error: 'Error',
};

export function statusText(d) {
  if (d.status === 'downloading') {
    const p = percent(d);
    return p == null ? formatBytes(d.downloadedBytes) : `${p.toFixed(1)}%`;
  }
  if (d.status === 'paused' && d.downloadedBytes > 0 && d.totalBytes) {
    return `Stopped · ${percent(d).toFixed(0)}%`;
  }
  return STATUS_LABELS[d.status] || d.status;
}
