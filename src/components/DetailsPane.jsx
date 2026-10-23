import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { formatBytes, formatDuration, formatSize, formatSpeed, percent, protocolLabel, STATUS_LABELS } from '../format.js';

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

// Streams: one cell per group of media segments, shaded by how many are done.
function PieceMap({ download }) {
  const pieces = download.pieces || [];
  if (!pieces.length) return <div className="segmap segmap-unknown">Reading the stream manifest…</div>;
  return (
    <div className="piecemap">
      {pieces.map((done, i) => (
        <span key={i} className={done >= 1 ? 'done' : ''} style={done > 0 && done < 1 ? { opacity: 0.35 + done * 0.65 } : null} />
      ))}
    </div>
  );
}

function streamSummary(d) {
  const info = d.streamInfo;
  if (!info) return '—';
  const parts = [protocolLabel(d)];
  if (info.width && info.height) parts.push(`${info.width}×${info.height}`);
  if (info.bandwidth) parts.push(`${(info.bandwidth / 1e6).toFixed(1)} Mbit/s`);
  parts.push(info.tracks.map((t) => `${t.type === 'main' ? 'video' : t.type} ${t.segments} segments`).join(', '));
  return parts.join(' · ');
}

export function DetailsPane({ download: d, onLogin }) {
  const p = percent(d);
  const isStream = d.kind === 'hls' || d.kind === 'dash';
  const active = isStream ? d.activeConnections : d.segments.filter((s) => s.active).length;
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
          {d.status === 'auth-required' && (
            <button type="button" className="btn btn-primary btn-small" onClick={onLogin}>
              <Icon name="lock" size={15} /> Log in
            </button>
          )}
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

      {isStream ? <PieceMap key={d.id} download={d} /> : <SegmentMap key={d.id} download={d} />}

      <dl className="details-grid">
        <dt>Address</dt>
        <dd className="mono ellipsis" title={d.url}>{d.url}</dd>
        <dt>Saved to</dt>
        <dd className="mono ellipsis" title={d.savePath || ''}>{d.savePath || '—'}</dd>
        <dt>Downloaded</dt>
        <dd>
          {formatBytes(d.downloadedBytes)} of {formatSize(d)}
          {p != null && ` (${p.toFixed(1)}%)`}
        </dd>
        <dt>Transfer rate</dt>
        <dd>{formatSpeed(d.speed) || '—'}</dd>
        <dt>Time left</dt>
        <dd>{d.status === 'downloading' ? formatDuration(d.eta) || '—' : '—'}</dd>
        <dt>Connections</dt>
        <dd>{d.status === 'downloading' ? `${active} active of ${d.connections}` : `${d.connections} max`}</dd>
        {isStream ? (
          <>
            <dt>Stream</dt>
            <dd className="ellipsis" title={streamSummary(d)}>{streamSummary(d)}</dd>
          </>
        ) : (
          <>
            <dt>Resume capability</dt>
            <dd>{d.probed === false ? 'Not checked yet' : d.resumable ? 'Yes' : 'No'}</dd>
          </>
        )}
        {d.hasLogin && (
          <>
            <dt>Login</dt>
            <dd>Saved</dd>
          </>
        )}
        {d.error && (
          <>
            <dt>{d.status === 'auth-required' ? 'Server' : 'Error'}</dt>
            <dd className="error-text">{d.error}</dd>
          </>
        )}
        {d.note && (
          <>
            <dt>Note</dt>
            <dd className="note-text">{d.note}</dd>
          </>
        )}
        {d.extraFiles?.length > 0 && (
          <>
            <dt>Also saved</dt>
            <dd className="mono ellipsis" title={d.extraFiles.join('\n')}>{d.extraFiles.join(', ')}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
