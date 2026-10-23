import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { formatBytes, formatDuration, formatSpeed, percent, STATUS_LABELS } from '../format.js';

// Visual map of the file: each connection's downloaded span is drawn at its
// byte offset, the way multi-connection download managers show progress.
function SegmentMap({ download }) {
  const total = download.totalBytes;
  if (download.status === 'completed') {
    return (
      <div className="segmap">
        <div className="segmap-fill done" style={{ left: 0, width: '100%' }} />
      </div>
    );
  }
  if (!total) {
    return <div className="segmap segmap-unknown">Size unknown — single connection</div>;
  }
  return (
    <div className="segmap">
      {download.segments.map((s, i) => (
        <div
          key={`${s.start}-${i}`}
          className={`segmap-fill ${s.active ? 'active' : ''}`}
          style={{ left: `${(s.start / total) * 100}%`, width: `${(s.downloaded / total) * 100}%` }}
        />
      ))}
      {download.segments.map((s, i) =>
        i === 0 ? null : (
          <div key={`b${s.start}`} className="segmap-boundary" style={{ left: `${(s.start / total) * 100}%` }} />
        ),
      )}
    </div>
  );
}

export function DetailsPane({ download: d }) {
  const p = percent(d);
  const active = d.segments.filter((s) => s.active).length;
  return (
    <section className="details" aria-label="Download details">
      <div className="details-head">
        <div className="details-title">
          <span className={`file-icon cat-${d.category}`}>
            <Icon name={d.category} size={18} />
          </span>
          <strong>{d.fileName || 'Resolving file name…'}</strong>
          <span className={`pill pill-${d.status}`}>{STATUS_LABELS[d.status]}</span>
        </div>
        <div className="details-actions">
          <button type="button" className="btn btn-ghost" onClick={() => api.copy(d.url)} title="Copy address">
            <Icon name="copy" size={15} /> Copy URL
          </button>
          {d.status === 'completed' && (
            <button type="button" className="btn btn-ghost" onClick={() => api.openFile(d.id)}>
              <Icon name="open" size={15} /> Open
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => api.showInFolder(d.id)}>
            <Icon name="folder" size={15} /> Folder
          </button>
        </div>
      </div>

      <SegmentMap key={d.id} download={d} />

      <dl className="details-grid">
        <dt>Address</dt>
        <dd className="mono ellipsis" title={d.url}>{d.url}</dd>
        <dt>Saved to</dt>
        <dd className="mono ellipsis" title={d.savePath || ''}>{d.savePath || '—'}</dd>
        <dt>Downloaded</dt>
        <dd>
          {formatBytes(d.downloadedBytes)} of {formatBytes(d.totalBytes)}
          {p != null && ` (${p.toFixed(1)}%)`}
        </dd>
        <dt>Transfer rate</dt>
        <dd>{formatSpeed(d.speed) || '—'}</dd>
        <dt>Time left</dt>
        <dd>{d.status === 'downloading' ? formatDuration(d.eta) || '—' : '—'}</dd>
        <dt>Connections</dt>
        <dd>
          {d.status === 'downloading' ? `${active} active of ${d.connections}` : `${d.connections} max`}
        </dd>
        <dt>Resume capability</dt>
        <dd>{d.probed === false ? 'Not checked yet' : d.resumable ? 'Yes' : 'No'}</dd>
        {d.error && (
          <>
            <dt>Error</dt>
            <dd className="error-text">{d.error}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
