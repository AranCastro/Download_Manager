import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { Modal } from './Modal.jsx';

const TABS = [
  ['general', 'General'],
  ['connection', 'Connection'],
  ['browser', 'Browser'],
  ['mcp', 'MCP / AI'],
];

const cleanError = (err) => err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function FfmpegField({ value, onChange }) {
  const [result, setResult] = useState(null);
  const check = async (bin = value) => {
    setResult({ checking: true });
    try {
      setResult((await api.checkFfmpeg(bin)) || { missing: true });
    } catch (err) {
      setResult({ missing: true, error: cleanError(err) });
    }
  };
  useEffect(() => {
    check();
    // Only on open; later checks are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="field">
      <span>FFmpeg (merges audio and video of HLS/DASH streams)</span>
      <div className="field-row">
        <input type="text" placeholder="Found on PATH" value={value} onChange={(e) => onChange(e.target.value)} />
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const file = await api.chooseFile(value);
            if (file) {
              onChange(file);
              check(file);
            }
          }}
        >
          Browse…
        </button>
        <button type="button" className="btn" onClick={() => check()}>Check</button>
      </div>
      <small className={result?.missing ? 'warn-text' : ''}>
        {result?.checking && 'Checking…'}
        {result?.version && `Found: ${result.version}`}
        {result?.missing &&
          'Not found. Streams are still saved, but separate audio and video stay as two files. Install it with “winget install Gyan.FFmpeg” or choose ffmpeg.exe.'}
      </small>
    </div>
  );
}

function BrowserTab() {
  const [pairings, setPairings] = useState([]);
  const [folders, setFolders] = useState({});
  useEffect(() => {
    api.pairings().then(setPairings);
    Promise.all([api.extensionFolder('chromium'), api.extensionFolder('firefox')]).then(([chromium, firefox]) =>
      setFolders({ chromium, firefox }),
    );
  }, []);
  return (
    <div className="tab-panel">
      <p>
        The browser extension sends downloads, links (right-click → <em>Download with Download Manager</em>) and video
        streams it detects on a page to this app, together with the browser’s cookies so that signed-in downloads work.
      </p>
      <ol className="steps">
        <li>
          <strong>Chrome, Edge, Brave, Opera:</strong> open <code>chrome://extensions</code> (or{' '}
          <code>edge://extensions</code>), turn on <em>Developer mode</em>, choose <em>Load unpacked</em> and select the
          folder below.
          <div className="field-row">
            <input type="text" readOnly value={folders.chromium || ''} aria-label="Chromium extension folder" />
            <button type="button" className="btn" onClick={() => api.openExtensionFolder('chromium')}>Open folder</button>
          </div>
        </li>
        <li>
          <strong>Firefox:</strong> open <code>about:debugging#/runtime/this-firefox</code>, choose{' '}
          <em>Load Temporary Add-on</em> and select <code>manifest.json</code> in this folder.
          <div className="field-row">
            <input type="text" readOnly value={folders.firefox || ''} aria-label="Firefox extension folder" />
            <button type="button" className="btn" onClick={() => api.openExtensionFolder('firefox')}>Open folder</button>
          </div>
        </li>
        <li>
          Click the Download Manager button in the browser toolbar, then <em>Connect</em>, and allow the request here.
        </li>
      </ol>
      <h3 className="subhead">Connected browsers</h3>
      {pairings.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="pairings">
          {pairings.map((p) => (
            <li key={p.id}>
              <Icon name="puzzle" size={16} />
              <span>
                <strong>{p.browser}</strong>
                <small className="muted"> connected {new Date(p.createdAt).toLocaleDateString()}</small>
              </span>
              <button type="button" className="btn btn-ghost" onClick={async () => setPairings(await api.revokePairing(p.id))}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SettingsDialog({ settings, onClose }) {
  const [tab, setTab] = useState('general');
  const [draft, setDraft] = useState(settings);
  const [info, setInfo] = useState(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    api.apiInfo().then(setInfo);
  }, []);

  const set = (key) => (e) => {
    const { type, checked, value } = e.target;
    setDraft((d) => ({ ...d, [key]: type === 'checkbox' ? checked : type === 'number' ? Number(value) : value }));
  };

  const save = async () => {
    await api.updateSettings(draft);
    onClose();
  };

  const copy = (label, text) => {
    api.copy(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 1500);
  };

  // The bundled Electron runtime runs the MCP script, so no Node.js install is needed.
  const claudeConfig = info
    ? JSON.stringify(
        {
          mcpServers: {
            'download-manager': {
              command: info.executable,
              args: [info.mcpScript],
              env: { ELECTRON_RUN_AS_NODE: '1' },
            },
          },
        },
        null,
        2,
      )
    : '';

  return (
    <Modal
      title="Options"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save}>Save</button>
        </>
      }
    >
      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? 'is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <div className="tab-panel">
          <div className="field">
            <span>Download folder</span>
            <div className="field-row">
              <input type="text" value={draft.downloadDir} onChange={set('downloadDir')} />
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const dir = await api.chooseDirectory(draft.downloadDir);
                  if (dir) setDraft((d) => ({ ...d, downloadDir: dir }));
                }}
              >
                Browse…
              </button>
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={draft.categoryFolders} onChange={set('categoryFolders')} />
            Sort files into category sub-folders (Video, Music, Documents, …)
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.clipboardMonitor} onChange={set('clipboardMonitor')} />
            Offer to download file links copied to the clipboard
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.notifyOnComplete} onChange={set('notifyOnComplete')} />
            Show a notification when a download completes
          </label>
          <FfmpegField value={draft.ffmpegPath} onChange={(ffmpegPath) => setDraft((d) => ({ ...d, ffmpegPath }))} />
        </div>
      )}

      {tab === 'browser' && <BrowserTab />}

      {tab === 'connection' && (
        <div className="tab-panel grid-2">
          <label className="field">
            <span>Connections per download</span>
            <input type="number" min="1" max="32" value={draft.connections} onChange={set('connections')} />
            <small>Files are split into this many parts downloaded in parallel (1–32).</small>
          </label>
          <label className="field">
            <span>Simultaneous downloads</span>
            <input type="number" min="1" max="20" value={draft.maxConcurrent} onChange={set('maxConcurrent')} />
            <small>Further downloads wait in the queue.</small>
          </label>
          <label className="field">
            <span>Speed limit (KB/s)</span>
            <input type="number" min="0" step="64" value={draft.speedLimitKBps} onChange={set('speedLimitKBps')} />
            <small>Total for all downloads. 0 means unlimited.</small>
          </label>
          <label className="field">
            <span>Local API port</span>
            <input type="number" min="1024" max="65535" value={draft.apiPort} onChange={set('apiPort')} />
            <small>Used by the MCP server. Takes effect after a restart.</small>
          </label>
        </div>
      )}

      {tab === 'mcp' && (
        <div className="tab-panel">
          <p className="mcp-status">
            <Icon name="plug" size={16} />
            {info?.url ? (
              <>
                Local API listening on <code>{info.url}</code>
              </>
            ) : (
              'Local API is not running.'
            )}
          </p>
          <p>
            The MCP server lets Claude (or any MCP client) add files, FTP links and video streams, list, pause, resume
            and remove downloads, supply logins, run the scheduler and change these settings. Add this to <code>claude_desktop_config.json</code> and restart Claude Desktop:
          </p>
          <div className="codeblock">
            <pre>{claudeConfig}</pre>
            <button type="button" className="btn btn-ghost" onClick={() => copy('config', claudeConfig)}>
              <Icon name="copy" size={14} /> {copied === 'config' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="muted">
            The server finds this app through <code>api.json</code> in the app data folder, so no token is needed in
            the config. Other clients can call the REST API directly with this bearer token:
          </p>
          <div className="field-row">
            <input type="password" readOnly value={info?.token || ''} aria-label="API token" />
            <button type="button" className="btn" onClick={() => copy('token', info?.token || '')}>
              {copied === 'token' ? 'Copied' : 'Copy token'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
