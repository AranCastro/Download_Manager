import { useState } from 'react';
import { api } from '../api.js';
import { Modal } from './Modal.jsx';

const cleanError = (err) => err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function LoginDialog({ download, onClose }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  let site = download.url;
  try {
    const u = new URL(download.url);
    site = `${u.protocol}//${u.host}`;
  } catch {
    // keep the raw URL
  }

  const submit = async (e) => {
    e?.preventDefault();
    if (!username) return setError('Enter a user name.');
    try {
      await api.setCredentials(download.id, { username, password, remember });
      onClose();
    } catch (err) {
      setError(cleanError(err));
    }
  };

  return (
    <Modal
      title="Login required"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Later</button>
          <button type="button" className="btn btn-primary" onClick={submit}>Log in and download</button>
        </>
      }
    >
      <form onSubmit={submit}>
        <p>
          <strong>{site}</strong> needs a user name and password for <strong>{download.fileName}</strong>.
        </p>
        {download.error && <p className="muted">{download.error}</p>}
        <label className="field">
          <span>User name</span>
          <input type="text" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this login for {site}
        </label>
        <p className="muted small">Logins are stored encrypted with your Windows account.</p>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
