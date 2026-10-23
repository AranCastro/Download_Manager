import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { Modal } from './Modal.jsx';

const TABS = [
  ['general', 'General'],
  ['connection', 'Connection'],
  ['mcp', 'MCP / AI'],
];

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
        </div>
      )}

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
            The MCP server lets Claude (or any MCP client) add, list, pause, resume and remove downloads and change
            these settings. Add this to <code>claude_desktop_config.json</code> and restart Claude Desktop:
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
