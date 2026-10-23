import { Icon } from '../icons.jsx';

export function Sidebar({ downloads, categories, view, onView }) {
  const count = (fn) => downloads.filter(fn).length;
  const item = (key, label, icon, n, nested = false) => (
    <button
      key={key}
      type="button"
      className={`side-item ${nested ? 'side-nested' : ''} ${view === key ? 'is-active' : ''}`}
      onClick={() => onView(key)}
    >
      <Icon name={icon} size={16} />
      <span className="side-label">{label}</span>
      {n > 0 && <span className="side-count">{n}</span>}
    </button>
  );

  return (
    <nav className="sidebar" aria-label="Categories">
      <div className="side-heading">Categories</div>
      {item('all', 'All Downloads', 'all', downloads.length)}
      {categories.map((c) => item(`cat:${c}`, c, c, count((d) => d.category === c), true))}
      <div className="side-heading">Status</div>
      {item('active', 'Active & Queued', 'download', count((d) => ['connecting', 'downloading', 'merging', 'queued'].includes(d.status)))}
      {item('scheduled', 'Scheduled', 'calendar', count((d) => d.status === 'scheduled'))}
      {item('unfinished', 'Unfinished', 'clock', count((d) => d.status !== 'completed'))}
      {item('finished', 'Finished', 'check', count((d) => d.status === 'completed'))}
    </nav>
  );
}
