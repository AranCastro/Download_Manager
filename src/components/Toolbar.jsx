import { Icon } from '../icons.jsx';

const SORTS = [
  ['createdAt', 'Date added'],
  ['fileName', 'Name'],
  ['totalBytes', 'Size'],
  ['progress', 'Progress'],
  ['speed', 'Speed'],
  ['status', 'Status'],
];

function Tool({ icon, label, onClick, disabled, title, secondary }) {
  return (
    <button type="button" className={`tool ${secondary ? 'tool-secondary' : ''}`} onClick={onClick} disabled={disabled} title={title || label} aria-label={label}>
      <Icon name={icon} size={17} />
      <span>{label}</span>
    </button>
  );
}

export function Toolbar({ title, count, can, actions, sort, onSort, density, onDensity, selectionSize }) {
  return (
    <div className="toolbar">
      <div className="toolbar-title">
        <h1>{title}</h1>
        <span className="muted">{selectionSize > 1 ? `${selectionSize} selected` : `${count} item${count === 1 ? '' : 's'}`}</span>
      </div>
      <div className="toolbar-actions" role="toolbar" aria-label="Download actions">
        <Tool icon="play" label="Resume" onClick={actions.resume} disabled={!can.resume} title="Resume (Space)" />
        <Tool icon="pause" label="Pause" onClick={actions.stop} disabled={!can.stop} title="Pause (Space)" />
        <Tool icon="calendar" label="Schedule" onClick={actions.schedule} disabled={!can.schedule} />
        <Tool icon="trash" label="Delete" onClick={actions.remove} disabled={!can.remove} title="Delete (Del)" />
        <span className="toolbar-sep" />
        <Tool icon="playAll" label="Resume all" onClick={actions.resumeAll} disabled={!can.resumeAll} secondary />
        <Tool icon="stopAll" label="Pause all" onClick={actions.stopAll} disabled={!can.stopAll} secondary />
        <Tool icon="sweep" label="Clear finished" onClick={actions.removeCompleted} disabled={!can.removeCompleted} secondary />
      </div>
      <div className="toolbar-view">
        <label className="select-inline" title="Sort">
          <Icon name="sort" size={15} />
          <select
            value={sort.key}
            onChange={(e) => onSort({ key: e.target.value, dir: e.target.value === 'fileName' ? 'asc' : 'desc' })}
            aria-label="Sort by"
          >
            {SORTS.map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="Density">
          <button type="button" className={density === 'comfortable' ? 'is-on' : ''} onClick={() => onDensity('comfortable')} title="Comfortable rows" aria-pressed={density === 'comfortable'}>
            <Icon name="rows" size={15} />
          </button>
          <button type="button" className={density === 'compact' ? 'is-on' : ''} onClick={() => onDensity('compact')} title="Compact table" aria-pressed={density === 'compact'}>
            <Icon name="list" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
