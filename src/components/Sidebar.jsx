import { Icon } from '../icons.jsx';
import { formatBytes, formatSpeed, ACTIVE } from '../format.js';
import { SpeedChart } from '../charts/SpeedChart.jsx';

const isToday = (ms) => ms && new Date(ms).toDateString() === new Date().toDateString();

export function Sidebar({ downloads, categories, view, onView, onAdd, speedSamples, speed }) {
  const count = (fn) => downloads.filter(fn).length;
  const item = (key, label, icon, n, { nested = false, tone } = {}) => (
    <button
      key={key}
      type="button"
      className={`side-item ${nested ? 'side-nested' : ''} ${view === key ? 'is-active' : ''}`}
      onClick={() => onView(key)}
      aria-current={view === key ? 'page' : undefined}
    >
      <Icon name={icon} size={17} />
      <span className="side-label">{label}</span>
      {n > 0 && <span className={`side-count ${tone ? `tone-${tone}` : ''}`}>{n}</span>}
    </button>
  );

  const active = count((d) => ACTIVE.has(d.status) || d.status === 'queued');
  const attention = count((d) => d.status === 'error' || d.status === 'auth-required');
  const today = downloads
    .filter((d) => d.status === 'completed' && isToday(d.completedAt))
    .reduce((sum, d) => sum + (d.totalBytes || 0), 0);

  return (
    <nav className="sidebar" aria-label="Library">
      <button type="button" className="new-download" onClick={onAdd}>
        <Icon name="plus" size={18} strokeWidth={2.2} />
        New download
        <kbd>Ctrl N</kbd>
      </button>

      <div className="side-scroll">
        <div className="side-heading">Library</div>
        {item('all', 'All downloads', 'all', downloads.length)}
        {item('active', 'In progress', 'download', active, { tone: active ? 'accent' : undefined })}
        {item('scheduled', 'Scheduled', 'calendar', count((d) => d.status === 'scheduled'))}
        {item('unfinished', 'Unfinished', 'clock', count((d) => d.status !== 'completed'))}
        {item('finished', 'Finished', 'checkCircle', count((d) => d.status === 'completed'))}
        {attention > 0 && item('attention', 'Needs attention', 'alert', attention, { tone: 'danger' })}

        <div className="side-heading">Categories</div>
        {categories.map((c) => item(`cat:${c}`, c, c, count((d) => d.category === c)))}
      </div>

      <section className="speed-card" aria-label="Throughput">
        <div className="speed-card-head">
          <span>Throughput</span>
          <strong>{formatSpeed(speed) || 'Idle'}</strong>
        </div>
        <SpeedChart samples={speedSamples} height={46} compact title="Total transfer rate" />
        <div className="speed-card-foot">
          <span>Today</span>
          <span>{formatBytes(today)}</span>
        </div>
      </section>
    </nav>
  );
}
