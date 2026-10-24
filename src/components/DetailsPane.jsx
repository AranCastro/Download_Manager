import { useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { SpeedChart } from '../charts/SpeedChart.jsx';
import {
  formatBytes,
  formatClock,
  formatDuration,
  formatRelative,
  formatSize,
  formatSpeed,
  percent,
  protocolLabel,
  STATUS_LABELS,
} from '../format.js';

// Each connection's downloaded span drawn at its byte offset in the file.
function SegmentMap({ d }) {
  const total = d.totalBytes;
  if (d.status === 'completed') return <div className="segmap"><div className="segmap-fill done" style={{ left: 0, width: '100%' }} /></div>;
  if (!total || !d.segments?.length) return <div className="segmap segmap-unknown">Size unknown — one connection</div>;
  return (
    <div className="segmap">
      {d.segments.map((s, i) => (
        <div key={`${s.start}-${i}`} className={`segmap-fill ${s.active ? 'active' : ''}`} style={{ left: `${(s.start / total) * 100}%`, width: `${(s.downloaded / total) * 100}%` }} />
      ))}
      {d.segments.map((s, i) => (i === 0 ? null : <div key={`b${s.start}`} className="segmap-boundary" style={{ left: `${(s.start / total) * 100}%` }} />))}
    </div>
  );
}

// Streams: one cell per group of media segments.
function PieceMap({ d }) {
  const pieces = d.pieces || [];
  if (!pieces.length) return <div className="segmap segmap-unknown">Reading the stream manifest…</div>;
  return (
    <div className="piecemap">
      {pieces.map((done, i) => (
        <span key={i} className={done >= 1 ? 'done' : ''} style={done > 0 && done < 1 ? { opacity: 0.35 + done * 0.65 } : null} />
      ))}
    </div>
  );
}

// Video pages: yt-dlp reports bytes only, so one bar shows overall progress.
function SiteBar({ d }) {
  const p = d.status === 'completed' ? 100 : percent(d) ?? 0;
  return (
    <div className="segmap">
      <div className={`segmap-fill ${d.status === 'completed' ? 'done' : 'active'}`} style={{ left: 0, width: `${p}%` }} />
    </div>
  );
}

function Source({ d }) {
  const info = d.siteInfo || {};
  return (
    <dl className="kv">
      <dt>Site</dt>
      <dd>{info.site || protocolLabel(d)}</dd>
      <dt>Title</dt>
      <dd>{info.title || '—'}</dd>
      <dt>Channel</dt>
      <dd>{info.uploader || '—'}</dd>
      <dt>Duration</dt>
      <dd>{info.duration ? formatClock(info.duration) : '—'}</dd>
      <dt>Quality</dt>
      <dd>{{ best: 'Best available', audio: 'Audio only (M4A)', mp3: 'Audio only (MP3)' }[d.quality] || `Up to ${d.quality}p`}</dd>
      <dt>Handled by</dt>
      <dd>yt-dlp{d.headers?.Cookie ? ', with your browser sign-in' : ''}</dd>
    </dl>
  );
}

function Stat({ label, value, mono }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${mono ? 'mono' : ''}`} title={typeof value === 'string' ? value : undefined}>{value || '—'}</span>
    </div>
  );
}

function Overview({ d, isStream }) {
  const info = d.streamInfo;
  const isSite = d.kind === 'site';
  return (
    <div className="overview">
      {isSite ? <SiteBar d={d} /> : isStream ? <PieceMap d={d} /> : <SegmentMap d={d} />}
      <div className="stats">
        <Stat label="Downloaded" value={`${formatBytes(d.downloadedBytes)} of ${formatSize(d)}`} />
        <Stat label="Speed" value={formatSpeed(d.speed)} />
        <Stat label="Time left" value={d.status === 'downloading' ? formatDuration(d.eta) : ''} />
        {isSite ? (
          <Stat label="Video" value={d.siteInfo?.height ? `${d.siteInfo.height}p` : d.quality === 'audio' || d.quality === 'mp3' ? 'Audio only' : ''} />
        ) : (
          <Stat label="Connections" value={d.status === 'downloading' ? `${d.activeConnections} of ${d.connections}` : `${d.connections} max`} />
        )}
        {isSite ? (
          <Stat label="Channel" value={d.siteInfo?.uploader} />
        ) : isStream ? (
          <Stat label="Video" value={info?.height ? `${info.width}×${info.height}${info.bandwidth ? ` · ${(info.bandwidth / 1e6).toFixed(1)} Mbit/s` : ''}` : ''} />
        ) : (
          <Stat label="Resumable" value={d.probed === false ? 'Not checked yet' : d.resumable ? 'Yes' : 'No'} />
        )}
        <Stat label={d.completedAt ? 'Finished' : 'Added'} value={formatRelative(d.completedAt || d.createdAt)} />
      </div>
      <dl className="kv">
        <dt>Address</dt>
        <dd className="mono ellipsis" title={d.url}>{d.url}</dd>
        <dt>Saved to</dt>
        <dd className="mono ellipsis" title={d.savePath || ''}>{d.savePath || '—'}</dd>
        {d.extraFiles?.length > 0 && (
          <>
            <dt>Also saved</dt>
            <dd className="mono ellipsis" title={d.extraFiles.join('\n')}>{d.extraFiles.join(', ')}</dd>
          </>
        )}
        {d.hasLogin && (
          <>
            <dt>Login</dt>
            <dd>Saved (encrypted)</dd>
          </>
        )}
      </dl>
      {d.error && (
        <p className={`callout ${d.status === 'auth-required' ? 'callout-warn' : 'callout-danger'}`}>
          <Icon name="alert" size={16} /> {d.error}
        </p>
      )}
      {d.note && (
        <p className="callout callout-warn">
          <Icon name="info" size={16} /> {d.note}
        </p>
      )}
    </div>
  );
}

function Connections({ d, isStream }) {
  if (isStream) {
    const tracks = d.streamInfo?.tracks || [];
    return (
      <table className="mini-table">
        <thead>
          <tr><th>Track</th><th>Segments</th><th>Progress</th></tr>
        </thead>
        <tbody>
          {tracks.map((t) => (
            <tr key={t.type}>
              <td>{t.type === 'main' ? 'Video and audio' : t.type === 'video' ? 'Video' : 'Audio'}</td>
              <td>{t.segments}</td>
              <td>{d.status === 'completed' ? 'Complete' : `${d.segmentsDone} of ${d.segmentsTotal} segments overall`}</td>
            </tr>
          ))}
          {!tracks.length && <tr><td colSpan="3" className="muted">Starts when the download begins.</td></tr>}
        </tbody>
      </table>
    );
  }
  const segments = d.segments || [];
  return (
    <table className="mini-table">
      <thead>
        <tr><th>#</th><th>Byte range</th><th>Downloaded</th><th className="col-mini-bar">Progress</th><th>State</th></tr>
      </thead>
      <tbody>
        {segments.map((s, i) => {
          const size = s.end == null ? null : s.end - s.start + 1;
          const p = size ? Math.min(100, (s.downloaded / size) * 100) : null;
          const done = size != null && s.downloaded >= size;
          return (
            <tr key={`${s.start}-${i}`}>
              <td>{i + 1}</td>
              <td className="mono">{formatBytes(s.start)} – {s.end == null ? 'end' : formatBytes(s.end + 1)}</td>
              <td>{formatBytes(s.downloaded)}</td>
              <td className="col-mini-bar">
                <div className={`bar bar-thin ${done ? 'bar-completed' : ''}`}><div className="bar-fill" style={{ width: `${p ?? 0}%` }} /></div>
              </td>
              <td>{done ? 'Done' : s.active ? <span className="live-dot">Receiving</span> : 'Waiting'}</td>
            </tr>
          );
        })}
        {!segments.length && (
          <tr><td colSpan="5" className="muted">{d.status === 'completed' ? 'All connections finished.' : 'Connections open when the download starts.'}</td></tr>
        )}
      </tbody>
    </table>
  );
}

export function DetailsPane({ download: d, samples, onLogin, onClose }) {
  const [tab, setTab] = useState('overview');
  const isStream = d.kind === 'hls' || d.kind === 'dash';
  const p = percent(d);
  const tabs = [
    ['overview', 'Overview'],
    ['connections', d.kind === 'site' ? 'Source' : isStream ? 'Tracks' : `Connections${d.segments?.length ? ` (${d.segments.length})` : ''}`],
    ['speed', 'Speed'],
  ];
  return (
    <section className="details" aria-label="Download details">
      <header className="details-head">
        <div className={`row-icon cat-${d.category}`}><Icon name={d.category} size={20} /></div>
        <div className="details-title">
          <strong title={d.fileName}>{d.fileName || 'Resolving file name…'}</strong>
          <span className="muted">
            {STATUS_LABELS[d.status]}
            {p != null && d.status !== 'completed' ? ` · ${p.toFixed(1)}%` : ''}
            {protocolLabel(d) ? ` · ${protocolLabel(d)}` : ''}
            {isStream && d.streamInfo?.duration ? ` · ${formatClock(d.streamInfo.duration)}` : ''}
            {d.kind === 'site' && d.siteInfo?.duration ? ` · ${formatClock(d.siteInfo.duration)}` : ''}
            {d.kind === 'site' && d.siteInfo?.uploader ? ` · ${d.siteInfo.uploader}` : ''}
          </span>
        </div>
        <div className="details-actions">
          {d.status === 'auth-required' && (
            <button type="button" className="btn btn-primary btn-small" onClick={onLogin}>
              <Icon name="lock" size={15} /> Sign in
            </button>
          )}
          {d.status === 'completed' && (
            <button type="button" className="btn btn-small" onClick={() => api.openFile(d.id)}>
              <Icon name="open" size={15} /> Open
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={() => api.showInFolder(d.id)}>
            <Icon name="folder" size={15} /> Folder
          </button>
          <button type="button" className="btn btn-small" onClick={() => api.copy(d.url)}>
            <Icon name="copy" size={15} /> Copy link
          </button>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details" title="Close (Esc)">
            <Icon name="x" size={16} />
          </button>
        </div>
      </header>
      <div className="tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`tab ${tab === key ? 'is-active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="details-body">
        {tab === 'overview' && <Overview d={d} isStream={isStream} />}
        {tab === 'connections' && (d.kind === 'site' ? <Source d={d} /> : <Connections d={d} isStream={isStream} />)}
        {tab === 'speed' && (
          samples?.length > 1 ? (
            <SpeedChart samples={samples} height={150} title="Transfer rate of this download" />
          ) : (
            <p className="muted">The graph fills in while the download runs.</p>
          )
        )}
      </div>
    </section>
  );
}
