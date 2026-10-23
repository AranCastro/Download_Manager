import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { Modal } from './Modal.jsx';

const URL_PATTERN = /^(https?|ftps?):\/\/\S+$/i;
const QUALITIES = [
  ['best', 'Best available'],
  ['1080', 'Up to 1080p'],
  ['720', 'Up to 720p'],
  ['480', 'Up to 480p'],
  ['worst', 'Smallest'],
];

const cleanError = (err) => err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function kindOf(url, given) {
  if (given) return given;
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

  const urls = text
    .split(/\s+/)
    .map((u) => u.trim())
    .filter(Boolean);
  const single = urls.length <= 1;
  const kinds = urls.map((u) => kindOf(u, byUrl.get(u)?.kind));
  const hasStream = kinds.some((k) => k !== 'file');
  const fromBrowser = urls.some((u) => byUrl.get(u)?.headers?.Cookie || byUrl.get(u)?.headers?.Referer);

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
          fileName: single && fileName.trim() ? fileName.trim() : undefined,
          directory: directory || undefined,
          connections: Number(connections),
          quality: kinds[i] !== 'file' ? quality : undefined,
          username: showLogin && username ? username : undefined,
          password: showLogin && username ? password : undefined,
          start: mode === 'start',
          schedule: mode === 'schedule',
        });
      }
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setBusy(false);
    }
  };

  const browse = async () => {
    const dir = await api.chooseDirectory(directory || settings.downloadDir);
    if (dir) setDirectory(dir);
  };

  return (
    <Modal
      title={urls.length > 1 ? `Add ${urls.length} downloads` : 'Add download'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => submit('schedule')} title="Start in the scheduler window">
            Schedule
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={busy} onClick={() => submit('later')}>Download later</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => submit('start')}>
            Start download{urls.length > 1 ? `s (${urls.length})` : ''}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Address</span>
        <textarea
          autoFocus
          rows={single ? 2 : 6}
          placeholder="https://… or ftp://… — paste several links on separate lines for a batch. Video streams (.m3u8, .mpd) are supported."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit('start')}
          spellCheck={false}
        />
      </label>
      {(hasStream || fromBrowser) && (
        <p className="hint">
          {hasStream && <span className="tag">{kinds.includes('dash') ? 'DASH' : 'HLS'} stream</span>}
          {fromBrowser && <span className="tag">Browser cookies and referrer attached</span>}
        </p>
      )}
      {single && (
        <label className="field">
          <span>Save as</span>
          <input
            type="text"
            placeholder={hasStream ? 'Automatic (saved as .mp4)' : 'Automatic (from the server)'}
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
          />
        </label>
      )}
      <div className="field">
        <span>Save to</span>
        <div className="field-row">
          <input
            type="text"
            readOnly
            value={directory || (settings.categoryFolders ? `${settings.downloadDir} (by category)` : settings.downloadDir)}
          />
          <button type="button" className="btn" onClick={browse}>Browse…</button>
          {directory && (
            <button type="button" className="btn btn-ghost" onClick={() => setDirectory('')}>Default</button>
          )}
        </div>
      </div>
      <div className="grid-2">
        <label className="field">
          <span>Connections: {connections}</span>
          <input type="range" min="1" max="32" value={connections} onChange={(e) => setConnections(e.target.value)} />
        </label>
        {hasStream && (
          <label className="field">
            <span>Video quality</span>
            <select value={quality} onChange={(e) => setQuality(e.target.value)}>
              {QUALITIES.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={showLogin} onChange={(e) => setShowLogin(e.target.checked)} />
        This server needs a login
      </label>
      {showLogin && (
        <div className="grid-2">
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
