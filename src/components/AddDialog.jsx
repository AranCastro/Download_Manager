import { useState } from 'react';
import { api } from '../api.js';
import { Modal } from './Modal.jsx';

// Accepts one URL or a batch (one per line).
export function AddDialog({ initialUrl, settings, onClose }) {
  const [text, setText] = useState(initialUrl || '');
  const [fileName, setFileName] = useState('');
  const [directory, setDirectory] = useState('');
  const [connections, setConnections] = useState(settings.connections);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const urls = text
    .split(/\s+/)
    .map((u) => u.trim())
    .filter(Boolean);
  const single = urls.length <= 1;

  const submit = async (start) => {
    setError('');
    const invalid = urls.find((u) => !/^https?:\/\/\S+$/i.test(u));
    if (!urls.length) return setError('Enter a download address.');
    if (invalid) return setError(`Not an http(s) address: ${invalid}`);
    setBusy(true);
    try {
      for (const url of urls) {
        await api.add({
          url,
          fileName: single && fileName.trim() ? fileName.trim() : undefined,
          directory: directory || undefined,
          connections: Number(connections),
          start,
        });
      }
      onClose();
    } catch (err) {
      setError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      setBusy(false);
    }
  };

  const browse = async () => {
    const dir = await api.chooseDirectory(directory || settings.downloadDir);
    if (dir) setDirectory(dir);
  };

  return (
    <Modal
      title="Add download"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={busy} onClick={() => submit(false)}>Download later</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => submit(true)}>
            Start download{urls.length > 1 ? `s (${urls.length})` : ''}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Address</span>
        <textarea
          autoFocus
          rows={single ? 2 : 5}
          placeholder="https://example.org/file.zip — paste several links on separate lines for a batch"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit(true)}
          spellCheck={false}
        />
      </label>
      {single && (
        <label className="field">
          <span>Save as</span>
          <input
            type="text"
            placeholder="Automatic (from the server)"
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
      <label className="field">
        <span>Connections: {connections}</span>
        <input
          type="range"
          min="1"
          max="32"
          value={connections}
          onChange={(e) => setConnections(e.target.value)}
        />
      </label>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}
