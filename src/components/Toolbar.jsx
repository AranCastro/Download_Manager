import { Icon } from '../icons.jsx';

const BUTTONS = [
  { key: 'add', label: 'Add URL', icon: 'plus', primary: true, always: true, title: 'Add a download (Insert)' },
  { key: 'resume', label: 'Resume', icon: 'play' },
  { key: 'stop', label: 'Stop', icon: 'stop' },
  { sep: true },
  { key: 'resumeAll', label: 'Resume All', icon: 'playAll' },
  { key: 'stopAll', label: 'Stop All', icon: 'stopAll' },
  { sep: true },
  { key: 'remove', label: 'Delete', icon: 'trash', title: 'Delete selected (Del)' },
  { key: 'removeCompleted', label: 'Delete Completed', icon: 'sweep' },
  { sep: true },
  { key: 'scheduler', label: 'Scheduler', icon: 'calendar', always: true },
  { key: 'openFolder', label: 'Open Folder', icon: 'folder', always: true },
  { key: 'settings', label: 'Options', icon: 'gear', always: true },
];

export function Toolbar({ can, actions, query, onQuery }) {
  return (
    <header className="toolbar">
      <div className="toolbar-buttons">
        {BUTTONS.map((b, i) =>
          b.sep ? (
            <span key={i} className="toolbar-sep" />
          ) : (
            <button
              key={b.key}
              type="button"
              className={`tool ${b.primary ? 'tool-primary' : ''}`}
              disabled={!b.always && !can[b.key]}
              onClick={actions[b.key]}
              title={b.title || b.label}
            >
              <Icon name={b.icon} size={22} />
              <span>{b.label}</span>
            </button>
          ),
        )}
      </div>
      <label className="search">
        <Icon name="search" size={16} />
        <input
          type="search"
          placeholder="Search downloads"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>
    </header>
  );
}
