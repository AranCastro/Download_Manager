import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { formatBytes, formatClock, hostOf, isYouTube } from '../format.js';
import { Modal } from './Modal.jsx';

const URL_PATTERN = /^(https?|ftps?):\/\/\S+$/i;
const MAX_PROBES = 25;

const cleanError = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const extensionKind = (url) => {
  if (isYouTube(url)) return 'site';
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

// Only thumbnails from YouTube's image servers are shown (the page's
// Content-Security-Policy allows no other remote images).
const safeThumbnail = (url) => (/^https:\/\/i\.ytimg\.com\//.test(url || '') ? url : null);

function InstallYtDlp({ onInstalled }) {
  const [state, setState] = useState(null);
  useEffect(() => api.onToolProgress?.((p) => p.name === 'ytdlp' && setState({ busy: true, ...p })), []);
  const install = async () => {
    setState({ busy: true });
    try {
      await api.installTool('ytdlp');
      setState(null);
      onInstalled();
    } catch (err) {
      setState({ error: cleanError(err) });
    }
  };
  return (
    <div className="probe probe-warn" role="status">
      <Icon name="download" size={18} />
      <span className="probe-text">
        <strong>Video pages need yt-dlp</strong>
        <span className="muted small">
          {state?.error ||
            (state?.busy
              ? `Downloading yt-dlp… ${state.done ? `${formatBytes(state.done)}${state.total ? ` of ${formatBytes(state.total)}` : ''}` : ''}`
              : 'A free, open-source tool that reads YouTube and other video sites. About 35 MB, installed into Anabranch’s own folder.')}
        </span>
      </span>
      <button type="button" className="btn btn-primary btn-small" disabled={state?.busy} onClick={install}>
        {state?.busy ? <span className="spinner spinner-small" /> : <Icon name="download" size={14} />} Install
      </button>
    </div>
  );
}

// What the server (or yt-dlp) told us about one link.
function ProbeCard({ result, url, onTryAsPage, onInstalled }) {
  if (!result || result === 'loading') {
    return (
      <div className="probe probe-loading" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>Checking {hostOf(url) || 'the link'}…</span>
      </div>
    );
  }
  if (result.toolMissing === 'ytdlp') return <InstallYtDlp onInstalled={onInstalled} />;
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
  if (result.isWebPage) {
    return (
      <div className="probe probe-warn" role="status">
        <Icon name="globe" size={18} />
        <span className="probe-text">
          <strong>This link opens a web page, not a file</strong>
          <span className="muted small">If the page plays a video, Anabranch can look for it with yt-dlp.</span>
        </span>
        <button type="button" className="btn btn-small" onClick={onTryAsPage}>
          <Icon name="Video" size={14} /> Find the video
        </button>
      </div>
    );
  }
  if (result.kind === 'site') {
    const thumb = safeThumbnail(result.thumbnail);
    const chips = [
      result.site,
      result.uploader,
      result.duration ? formatClock(result.duration) : null,
      result.qualities?.length ? `up to ${result.qualities[0].height}p` : null,
    ];
    return (
      <div className="probe probe-ok probe-video" role="status">
        {thumb ? (
          <img className="probe-thumb" src={thumb} alt="" />
        ) : (
          <span className="row-icon cat-Video"><Icon name="Video" size={20} /></span>
        )}
        <span className="probe-text">
          <strong className="probe-title" title={result.title}>{result.title}</strong>
          <span className="probe-chips">
            {chips.filter(Boolean).map((c) => (
              <span key={c} className="chip chip-quiet">{c}</span>
            ))}
          </span>
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

function batchState(r, label) {
  if (label) return label.duration ? formatClock(label.duration) : '';
  if (!r || r === 'loading') return <span className="spinner spinner-small" />;
  if (r.authRequired) return 'Sign-in';
  if (r.error) return 'Error';
  if (r.totalBytes != null) return formatBytes(r.totalBytes);
  if (r.duration) return formatClock(r.duration);
  return r.kind !== 'file' ? r.site || r.kind.toUpperCase() : '—';
}

function BatchList({ title, urls, results, labels = {} }) {
  const sizes = urls.map((u) => results[u]?.totalBytes).filter((n) => n != null);
  const done = urls.filter((u) => labels[u] || (results[u] && results[u] !== 'loading')).length;
  const checking = Math.min(urls.length, MAX_PROBES);
  return (
    <div className="batch">
      <div className="batch-head">
        <span>{title || `${urls.length} links`}</span>
        <span className="muted">
          {done < checking ? `Checking ${done}/${checking}…` : ''}
          {sizes.length ? ` ${formatBytes(sizes.reduce((a, b) => a + b, 0))} known` : ''}
        </span>
      </div>
      <ul>
        {urls.slice(0, 300).map((u) => {
          const r = results[u];
          const label = labels[u];
          return (
            <li key={u}>
              <Icon name={label ? 'Video' : r && r !== 'loading' && !r.error ? r.category || 'Video' : 'link'} size={15} />
              <span className="ellipsis" title={u}>{label?.title || r?.title || r?.fileName || u}</span>
              <span className={`batch-state ${r?.error && !label ? 'meta-danger' : ''}`}>{batchState(r, label)}</span>
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
  const [kindOverride, setKindOverride] = useState({});
  const [probeKey, setProbeKey] = useState(0);
  const probeRound = useRef(0);

  const urls = useMemo(() => [...new Set(text.split(/\s+/).map((u) => u.trim()).filter(Boolean))], [text]);
  const validUrls = urls.filter((u) => URL_PATTERN.test(u));
  const single = urls.length <= 1;
  const kindFor = (u) =>
    byUrl.get(u)?.kind || kindOverride[u] || (results[u]?.kind && results[u].kind !== 'file' ? results[u].kind : null) || extensionKind(u);
  const first = results[validUrls[0]];
  // A playlist link expands into one download per video.
  const playlist = single && first && first !== 'loading' && first.entries ? first : null;
  const targets = playlist ? playlist.entries.map((e) => e.url) : urls;
  const kinds = targets.map((u) => (playlist ? 'site' : kindFor(u)));
  const hasStream = kinds.some((k) => k !== 'file');
  const hasSite = kinds.includes('site');
  const fromBrowser = urls.some((u) => byUrl.get(u)?.headers?.Cookie || byUrl.get(u)?.headers?.Referer);
  const qualities = single && first && first !== 'loading' && !playlist ? first.qualities || [] : [];

  // Check the links shortly after typing stops, and again when a login is
  // entered, yt-dlp is installed or a page is to be read as a video page.
  useEffect(() => {
    const round = ++probeRound.current;
    const toProbe = validUrls.slice(0, MAX_PROBES);
    if (!toProbe.length) return undefined;
    const login = showLogin && username ? { username, password } : {};
    const timer = setTimeout(() => {
      setResults((prev) => Object.fromEntries(toProbe.map((u) => [u, prev[u] && !login.username && !probeKey && !kindOverride[u] ? prev[u] : 'loading'])));
      for (const url of toProbe) {
        const source = byUrl.get(url);
        api
          .probe({ url, kind: source?.kind || kindOverride[url], headers: source?.headers, ...login })
          .catch((err) => ({ error: cleanError(err) }))
          .then((result) => {
            if (probeRound.current === round) setResults((prev) => ({ ...prev, [url]: result }));
          });
      }
    }, 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validUrls.join('\n'), showLogin && username, showLogin && password, probeKey, JSON.stringify(kindOverride)]);

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
      for (const [i, url] of targets.entries()) {
        const source = byUrl.get(url) || (playlist ? byUrl.get(urls[0]) : null);
        await api.add({
          url,
          kind: kinds[i],
          headers: source?.headers,
          fileName: playlist ? undefined : single && fileName.trim() ? fileName.trim() : source?.fileName,
          directory: directory || undefined,
          connections: Number(connections),
          quality: kinds[i] !== 'file' ? quality : undefined,
          username: showLogin && username ? username : undefined,
          password: showLogin && username ? password : undefined,
          start: mode === 'start',
          schedule: mode === 'schedule',
        });
      }
      onClose({ added: targets.length, mode });
    } catch (err) {
      setError(cleanError(err));
      setBusy(false);
    }
  };

  const browse = async () => {
    const dir = await api.chooseDirectory(directory || settings.downloadDir);
    if (dir) setDirectory(dir);
  };

  const probed = single && first && first !== 'loading' ? first : null;
  const placeholderName = probed?.title || probed?.fileName || (hasStream ? 'Automatic (saved as .mp4)' : 'Automatic (from the server)');
  const playlistLabels = playlist ? Object.fromEntries(playlist.entries.map((e) => [e.url, e])) : {};
  const audioOnly = quality === 'audio' || quality === 'mp3';
  const folderHint = hasSite ? `: ${audioOnly ? 'Music' : 'Video'}` : '';

  return (
    <Modal
      title={playlist ? `Add playlist (${targets.length} videos)` : urls.length > 1 ? `Add ${urls.length} downloads` : 'New download'}
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
          <button type="button" className="btn btn-primary" disabled={busy || !urls.length || Boolean(first?.toolMissing)} onClick={() => submit('start')}>
            <Icon name="download" size={15} /> Download{targets.length > 1 ? ` ${targets.length}` : ''}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Address</span>
        <textarea
          autoFocus
          rows={single ? 2 : 4}
          placeholder="Paste a link: a file, an FTP address, a video stream (.m3u8, .mpd) or a YouTube video or playlist. Several links: one per line."
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
      {single && validUrls[0] && !playlist && (
        <ProbeCard
          result={results[validUrls[0]]}
          url={validUrls[0]}
          onTryAsPage={() => setKindOverride((k) => ({ ...k, [validUrls[0]]: 'site' }))}
          onInstalled={() => setProbeKey((n) => n + 1)}
        />
      )}
      {playlist && <BatchList title={`${playlist.playlist.title} · ${targets.length} videos`} urls={targets} results={{}} labels={playlistLabels} />}
      {!single && <BatchList urls={urls} results={results} />}

      {single && !playlist && (
        <label className="field">
          <span>Save as</span>
          <input type="text" placeholder={placeholderName} value={fileName} onChange={(e) => setFileName(e.target.value)} />
        </label>
      )}
      <div className="field">
        <span>Save to</span>
        <div className="field-row">
          <input
            type="text"
            readOnly
            value={directory || (settings.categoryFolders ? `${settings.downloadDir}  (sorted by category${folderHint})` : settings.downloadDir)}
          />
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
            <span>{hasSite ? 'Quality' : 'Video quality'}</span>
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
              {hasSite && (
                <>
                  <option value="audio">Audio only (M4A)</option>
                  <option value="mp3">Audio only (MP3)</option>
                </>
              )}
              {!hasSite && <option value="worst">Smallest</option>}
            </select>
          </label>
        )}
      </div>
      {hasSite && (
        <p className="hint">
          <Icon name="info" size={14} /> Save only videos you have the right to download, such as your own uploads or videos under a
          Creative Commons licence.
        </p>
      )}
      {/* Video sites sign in with the browser's cookies (sent by the extension), not a password. */}
      {!kinds.every((k) => k === 'site') && (
        <label className="check">
          <input type="checkbox" checked={showLogin} onChange={(e) => setShowLogin(e.target.checked)} />
          This server needs a sign-in
        </label>
      )}
      {showLogin && !kinds.every((k) => k === 'site') && (
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
