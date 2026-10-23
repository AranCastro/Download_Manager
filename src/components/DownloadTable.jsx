import { useRef } from 'react';
import { Icon } from '../icons.jsx';
import { formatBytes, formatDate, formatDuration, formatSpeed, percent, statusText } from '../format.js';

const COLUMNS = [
  { key: 'fileName', label: 'File Name', className: 'col-name' },
  { key: 'totalBytes', label: 'Size', className: 'col-num' },
  { key: 'status', label: 'Status', className: 'col-status' },
  { key: 'progress', label: 'Progress', className: 'col-progress' },
  { key: 'eta', label: 'Time Left', className: 'col-eta' },
  { key: 'speed', label: 'Transfer Rate', className: 'col-num' },
  { key: 'createdAt', label: 'Added', className: 'col-date' },
];

export function DownloadTable({ items, selected, onSelect, sort, onSort, onOpen, onContextMenu, emptyHint, onAdd }) {
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

  const toggleSort = (key) =>
    onSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  return (
    <div className="table-wrap" onClick={(e) => e.target === e.currentTarget && onSelect(new Set())}>
      <table className="downloads">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.key} className={c.className} onClick={() => toggleSort(c.key)}>
                {c.label}
                {sort.key === c.key && <span className="sort-mark">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((d, i) => {
            const p = percent(d);
            return (
              <tr
                key={d.id}
                className={`row status-${d.status} ${selected.has(d.id) ? 'is-selected' : ''}`}
                onClick={(e) => handleClick(e, d, i)}
                onDoubleClick={() => onOpen(d)}
                onContextMenu={(e) => onContextMenu(e, d)}
                title={d.error || d.url}
              >
                <td className="col-name">
                  <div className="name-cell">
                    <span className={`file-icon cat-${d.category}`}>
                      <Icon name={d.category} size={16} />
                    </span>
                    <span className="file-name">{d.fileName || d.url}</span>
                  </div>
                </td>
                <td className="col-num">{formatBytes(d.totalBytes)}</td>
                <td className="col-status">
                  <span className={`status-dot dot-${d.status}`} />
                  {statusText(d)}
                </td>
                <td className="col-progress">
                  <div className={`bar bar-${d.status}`}>
                    <div
                      className={`bar-fill ${p == null && d.status === 'downloading' ? 'bar-indeterminate' : ''}`}
                      style={{ width: `${p ?? (d.status === 'downloading' ? 100 : 0)}%` }}
                    />
                  </div>
                </td>
                <td className="col-eta">{d.status === 'downloading' ? formatDuration(d.eta) : ''}</td>
                <td className="col-num">{formatSpeed(d.speed)}</td>
                <td className="col-date">{formatDate(d.completedAt || d.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {items.length === 0 && (
        <div className="empty">
          <Icon name="download" size={40} strokeWidth={1.4} />
          {emptyHint ? (
            <>
              <p>No downloads yet. Copy a file link, or add one directly.</p>
              <button type="button" className="btn btn-primary" onClick={onAdd}>
                Add URL
              </button>
            </>
          ) : (
            <p>Nothing in this view.</p>
          )}
        </div>
      )}
    </div>
  );
}
