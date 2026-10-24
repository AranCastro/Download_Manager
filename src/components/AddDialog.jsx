import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { formatBytes, formatClock, hostOf } from '../format.js';
import { Modal } from './Modal.jsx';

const URL_PATTERN = /^(https?|ftps?):\/\/\S+$/i;
const MAX_PROBES = 25;

const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const extensionKind = (url) => {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'file';
};

// What the server told us about one link, shown before anything downloads.
function ProbeCard({ result, url }) {
  if (!result || result === 'loading') {
    return (
      <div className="probe probe-loading" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>Checking {hostOf(url) || 'the link'}…</span>
      </div>
    );
  }
  if (result.authRequired) {
    return (
      <div className="probe probe-warn" role="status">
        <Icon name="lock" size={18} />
        <span>
          <strong>{hostOf(url)} needs a sign-in</strong>
          <span className="muted">{result.realm ? ` · ${result.realm}` : ''} — enter it below, or add the download and sign in later.</span>
        </span>
      </div>
    );
  }
  if (result.error) {
    return (
      <div className="probe probe-danger" role="status">
        <Icon name="alert" size={18} />
        <span>
          <strong>Could not check this link</strong>
          <span className="muted"> · {result.error}</span>
        </span>
      </div>
    );
  }
  const stream = result.kind !== 'file';
  const chips = stream
    ? [
        result.kind === 'hls' ? 'HLS stream' : 'DASH stream',
        result.qualities?.length ? `up to ${result.qualities[0].height}p` : null,
        result.duration ? formatClock(result.duration) : null,
        result.separateAudio ? 'separate audio' : null,
      ]
    : [
        result.totalBytes != null ? formatBytes(result.totalBytes) : 'Size unknown',
        result.resumable ? 'Resumable · multi-connection' : 'One connection, no resume',
        result.category,
      ];
  return (
    <div className="probe probe-ok" role="status">
      <span className={`row-icon cat-${result.category}`}>
        <Icon name={result.category} size={20} />
      </span>
      <span className="probe-text">
        <strong className="ellipsis" title={result.fileName}>{result.fileName}</strong>
        <span className="probe-chips">
          {chips.filter(Boolean).map((c) => (
            <span key={c} className="chip chip-quiet">{c}</span>
          ))}
          <span className="muted small">{hostOf(url)}</span>
        </span>
      </span>
    </div>
  );
}

function BatchList({ urls, results }) {
  const sizes = urls.map((u) => results[u]?.totalBytes).filter((n) => n != null);
  const done = urls.filter((u) => results[u] && results[u] !== 'loading').length;
  return (
    <div className="batch">
      <div className="batch-head">
        <span>{urls.length} links</span>
        <span className="muted">
          {done < Math.min(urls.length, MAX_PROBES) ? `Checking ${done}/${Math.min(urls.length, MAX_PROBES)}…` : ''}
          {sizes.length ? ` ${formatBytes(sizes.reduce((a, b) => a + b, 0))} known` : ''}
        </span>
      </div>
      <ul>
        {urls.slice(0, 200).map((u) => {
          const r = results[u];
          return (
            <li key={u}>
              <Icon name={r && r !== 'loading' && !r.error ? r.category : 'link'} size={15} />
              <span className="ellipsis" title={u}>{r?.fileName || u}</span>
              <span className={`batch-state ${r?.error ? 'meta-danger' : ''}`}>
                {!r || r === 'loading' ? <span className="spinner spinner-small" /> : r.authRequired ? 'Sign-in' : r.error ? 'Error' : r.totalBytes != null ? formatBytes(r.totalBytes) : r.kind !== 'file' ? r.kind.toUpperCase() : '—'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Accepts one URL or a batch (one per line). Items that come from the browser
// extension carry the browser's cookies and referrer, kept per URL.
export function AddDialog({ items = [], settings, onClose }) {
  const byUrl = useMemo(() => new Map(items.map((i) => [i.url, i])), [items]);
  const [text, setText] = useState(items.map((i) => i.url).join('\n'));
  const [fileName, setFileName] = useState(items.length === 1 ? items[0].fileName || '' : '');
  const [directory, setDirectory] = useState('');
  const [connections, setConnections] = useState(settings.connections);
  const [quality, setQuality] = useState('best');
  const [showLogin, setShowLogin] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState({});
  const probeRound = useRef(0);

  const urls = useMemo(() => [...new Set(text.split(/\s+/).map((u) => u.trim()).filter(Boolean))], [text]);
  const validUrls = urls.filter((u) => URL_PATTERN.test(u));
  const single = urls.length <= 1;
  const kinds = urls.map((u) => byUrl.get(u)?.kind || results[u]?.kind || extensionKind(u));
  const hasStream = kinds.some((k) => k !== 'file');
  const fromBrowser = urls.some((u) => byUrl.get(u)?.headers?.Cookie || byUrl.get(u)?.headers?.Referer);
  const first = results[validUrls[0]];
  const qualities = single && first && first !== 'loading' ? first.qualities || [] : [];

  // Check the links shortly after typing stops (and again when a login is entered).
  useEffect(() => {
    const round = ++probeRound.current;
    const targets = validUrls.slice(0, MAX_PROBES);
    if (!targets.length) return undefined;
    const login = showLogin && username ? { username, password } : {};
    const timer = setTimeout(() => {
      setResults((prev) => Object.fromEntries(targets.map((u) => [u, prev[u] && !login.username ? prev[u] : 'loading'])));
      for (const url of targets) {
        const source = byUrl.get(url);
        api
          .probe({ url, kind: source?.kind, headers: source?.headers, ...login })
          .catch((err) => ({ error: cleanError(err) }))
          .then((result) => {
            if (probeRound.current === round) setResults((prev) => ({ ...prev, [url]: result }));
          });
      }
    }, 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validUrls.join('\n'), showLogin && username, showLogin && password]);

  // A server that asks for a sign-in opens the login fields.
  useEffect(() => {
    if (single && first?.authRequired) setShowLogin(true);
  }, [single, first?.authRequired]);

  const submit = async (mode) => {
    setError('');
    const invalid = urls.find((u) => !URL_PATTERN.test(u));
    if (!urls.length) return setError('Enter a download address.');
    if (invalid) return setError(`Not an http(s) or ftp address: ${invalid}`);
    setBusy(true);
    try {
      for (const [i, url] of urls.entries()) {
        const source = byUrl.get(url);
        await api.add({
          url,
          kind: source?.kind,
          headers: source?.headers,
          fileName: single && fileName.trim() ? fileName.trim() : source?.fileName,
          directory: directory || undefined,
          connections: Number(connections),
          quality: kinds[i] !== 'file' ? quality : undefined,
          username: showLogin && username ? username : undefined,
          password: showLogin && username ? password : undefined,
          start: mode === 'start',
          schedule: mode === 'schedule',
        });
      }
      onClose({ added: urls.length, mode });
    } catch (err) {
      setError(cleanError(err));
      setBusy(false);
    }
  };

  const browse = async () => {
    const dir = await api.chooseDirectory(directory || settings.downloadDir);
    if (dir) setDirectory(dir);
  };

  const placeholderName = single && first && first !== 'loading' && first.fileName ? first.fileName : hasStream ? 'Automatic (saved as .mp4)' : 'Automatic (from the server)';

  return (
    <Modal
      title={urls.length > 1 ? `Add ${urls.length} downloads` : 'New download'}
      onClose={() => onClose()}
      wide
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => submit('schedule')} title="Start in the scheduler window">
            <Icon name="calendar" size={15} /> Schedule
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => onClose()}>Cancel</button>
          <button type="button" className="btn" disabled={busy} onClick={() => submit('later')}>Add paused</button>
          <button type="button" className="btn btn-primary" disabled={busy || !urls.length} onClick={() => submit('start')}>
            <Icon name="download" size={15} /> Download{urls.length > 1 ? ` ${urls.length}` : ''}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Address</span>
        <textarea
          autoFocus
          rows={single ? 2 : 4}
          placeholder="Paste a link to a file, an FTP address or a video stream (.m3u8, .mpd). Several links: one per line."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit('start')}
          spellCheck={false}
        />
      </label>

      {fromBrowser && (
        <p className="hint">
          <Icon name="globe" size={14} /> Sent from your browser with its cookies and referrer, so signed-in downloads work.
        </p>
      )}
      {single && validUrls[0] && <ProbeCard result={results[validUrls[0]]} url={validUrls[0]} />}
      {!single && <BatchList urls={urls} results={results} />}

      {single && (
        <label className="field">
          <span>Save as</span>
          <input type="text" placeholder={placeholderName} value={fileName} onChange={(e) => setFileName(e.target.value)} />
        </label>
      )}
      <div className="field">
        <span>Save to</span>
        <div className="field-row">
          <input type="text" readOnly value={directory || (settings.categoryFolders ? `${settings.downloadDir}  (sorted by category)` : settings.downloadDir)} />
          <button type="button" className="btn" onClick={browse}>Browse…</button>
          {directory && (
            <button type="button" className="btn btn-ghost" onClick={() => setDirectory('')}>Default</button>
          )}
        </div>
      </div>
      <div className="grid-2">
        <label className="field">
          <span>
            Connections <output className="value-pill">{connections}</output>
          </span>
          <input type="range" min="1" max="32" value={connections} onChange={(e) => setConnections(e.target.value)} />
        </label>
        {hasStream && (
          <label className="field">
            <span>Video quality</span>
            <select value={quality} onChange={(e) => setQuality(e.target.value)}>
              <option value="best">Best available{qualities[0] ? ` (${qualities[0].height}p)` : ''}</option>
              {qualities.map((q) => (
                <option key={q.height} value={String(q.height)}>
                  {q.height}p{q.bandwidth ? ` · ${(q.bandwidth / 1e6).toFixed(1)} Mbit/s` : ''}
                </option>
              ))}
              {!qualities.length && (
                <>
                  <option value="1080">Up to 1080p</option>
                  <option value="720">Up to 720p</option>
                  <option value="480">Up to 480p</option>
                </>
              )}
              <option value="worst">Smallest</option>
            </select>
          </label>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={showLogin} onChange={(e) => setShowLogin(e.target.checked)} />
        This server needs a sign-in
      </label>
      {showLogin && (
        <div className="grid-2 login-fields">
          <label className="field">
            <span>User name</span>
            <input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}
