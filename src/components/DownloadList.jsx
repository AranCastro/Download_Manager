import { useRef } from 'react';
import { Icon } from '../icons.jsx';
import {
  describe,
  formatDate,
  formatDuration,
  formatSize,
  formatSpeed,
  hostOf,
  percent,
  protocolLabel,
  statusText,
  STATUS_LABELS,
} from '../format.js';
import { Welcome } from './Welcome.jsx';

const COLUMNS = [
  { key: 'fileName', label: 'Name', className: 'col-name' },
  { key: 'totalBytes', label: 'Size', className: 'col-num' },
  { key: 'status', label: 'Status', className: 'col-status' },
  { key: 'progress', label: 'Progress', className: 'col-progress' },
  { key: 'eta', label: 'Time left', className: 'col-eta' },
  { key: 'speed', label: 'Speed', className: 'col-num' },
  { key: 'createdAt', label: 'Added', className: 'col-date' },
];

function Progress({ d, thin = false }) {
  const p = percent(d);
  const indeterminate = (p == null && d.status === 'downloading') || d.status === 'merging' || d.status === 'connecting';
  return (
    <div className={`bar bar-${d.status} ${thin ? 'bar-thin' : ''}`} role="progressbar" aria-valuenow={p == null ? undefined : Math.round(p)} aria-valuemin="0" aria-valuemax="100">
      <div className={`bar-fill ${indeterminate ? 'bar-indeterminate' : ''}`} style={{ width: `${indeterminate ? 100 : p ?? 0}%` }} />
    </div>
  );
}

// The action on a row's main button depends on its state.
function primaryAction(d) {
  if (['downloading', 'connecting', 'merging', 'queued'].includes(d.status)) return { icon: 'pause', label: 'Pause', run: 'stop' };
  if (d.status === 'completed') return { icon: 'open', label: 'Open', run: 'open' };
  if (d.status === 'auth-required') return { icon: 'lock', label: 'Sign in', run: 'login' };
  if (d.status === 'error') return { icon: 'retry', label: 'Retry', run: 'resume' };
  return { icon: 'play', label: 'Resume', run: 'resume' };
}

function Row({ d, selected, schedule, onClick, onOpen, onContextMenu, onRowAction }) {
  const action = primaryAction(d);
  const tag = protocolLabel(d);
  const showBar = d.status !== 'completed';
  return (
    <div
      role="row"
      aria-selected={selected}
      tabIndex={-1}
      className={`row status-${d.status} ${selected ? 'is-selected' : ''}`}
      onClick={onClick}
      onDoubleClick={() => onOpen(d)}
      onContextMenu={(e) => onContextMenu(e, d)}
    >
      <div className={`row-icon cat-${d.category}`}>
        <Icon name={d.category} size={20} />
        {d.status === 'completed' && <span className="row-badge"><Icon name="check" size={11} strokeWidth={3} /></span>}
      </div>
      <div className="row-main">
        <div className="row-title">
          <span className="row-name" title={d.fileName}>{d.fileName || d.url}</span>
          {tag && <span className="tag tag-small">{tag}</span>}
        </div>
        {showBar && <Progress d={d} thin />}
        <div className="row-meta">
          <span className={d.status === 'error' || d.status === 'auth-required' ? 'meta-danger' : ''}>{describe(d, schedule)}</span>
          <span className="row-host">{hostOf(d.url)}</span>
        </div>
      </div>
      <div className="row-side">
        <span className={`pill pill-${d.status}`}>{STATUS_LABELS[d.status]}</span>
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="icon-btn" title={action.label} aria-label={action.label} onClick={() => onRowAction(action.run, d)}>
            <Icon name={action.icon} size={16} />
          </button>
          <button type="button" className="icon-btn" title="Show in folder" aria-label="Show in folder" onClick={() => onRowAction('folder', d)}>
            <Icon name="folder" size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="More"
            aria-label="More actions"
            onClick={(e) => onContextMenu(e, d, e.currentTarget.getBoundingClientRect())}
          >
            <Icon name="more" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function DownloadList({
  items,
  total,
  density,
  selected,
  onSelect,
  sort,
  onSort,
  onOpen,
  onContextMenu,
  onRowAction,
  schedule,
  welcomeActions,
}) {
  const anchor = useRef(null);

  const handleClick = (e, d, index) => {
    if (e.shiftKey && anchor.current != null) {
      const from = items.findIndex((x) => x.id === anchor.current);
      const [a, b] = from < index ? [from, index] : [index, from];
      onSelect(new Set(items.slice(Math.max(0, a), b + 1).map((x) => x.id)));
      return;
    }
    anchor.current = d.id;
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      next.has(d.id) ? next.delete(d.id) : next.add(d.id);
      onSelect(next);
    } else {
      onSelect(new Set([d.id]));
    }
  };

  if (total === 0) return <Welcome actions={welcomeActions} />;

  if (!items.length) {
    return (
      <div className="list-empty">
        <Icon name="search" size={28} strokeWidth={1.5} />
        <p>Nothing here.</p>
      </div>
    );
  }

  if (density === 'compact') {
    const toggleSort = (key) => onSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
    return (
      <div className="table-wrap" onClick={(e) => e.target === e.currentTarget && onSelect(new Set())}>
        <table className="downloads">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} className={c.className} onClick={() => toggleSort(c.key)} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  {c.label}
                  {sort.key === c.key && <span className="sort-mark">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((d, i) => (
              <tr
                key={d.id}
                className={`trow status-${d.status} ${selected.has(d.id) ? 'is-selected' : ''}`}
                onClick={(e) => handleClick(e, d, i)}
                onDoubleClick={() => onOpen(d)}
                onContextMenu={(e) => onContextMenu(e, d)}
                title={d.error || d.url}
              >
                <td className="col-name">
                  <div className="name-cell">
                    <span className={`file-icon cat-${d.category}`}>
                      <Icon name={d.category} size={15} />
                    </span>
                    <span className="file-name">{d.fileName || d.url}</span>
                    {protocolLabel(d) && <span className="tag tag-small">{protocolLabel(d)}</span>}
                  </div>
                </td>
                <td className="col-num">{formatSize(d)}</td>
                <td className="col-status">
                  <span className={`status-dot dot-${d.status}`} />
                  {statusText(d)}
                </td>
                <td className="col-progress"><Progress d={d} /></td>
                <td className="col-eta">{d.status === 'downloading' ? formatDuration(d.eta) : ''}</td>
                <td className="col-num">{formatSpeed(d.speed)}</td>
                <td className="col-date">{formatDate(d.completedAt || d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="rows" role="grid" aria-label="Downloads" onClick={(e) => e.target === e.currentTarget && onSelect(new Set())}>
      {items.map((d, i) => (
        <Row
          key={d.id}
          d={d}
          schedule={schedule}
          selected={selected.has(d.id)}
          onClick={(e) => handleClick(e, d, i)}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
          onRowAction={onRowAction}
        />
      ))}
    </div>
  );
}
