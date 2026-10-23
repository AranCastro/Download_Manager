import { useState } from 'react';
import { api } from '../api.js';
import { Modal } from './Modal.jsx';

export function DeleteDialog({ items, onClose }) {
  const [deleteFile, setDeleteFile] = useState(false);
  const anyCompleted = items.some((d) => d.status === 'completed');

  const confirm = async () => {
    await api.remove(items.map((d) => d.id), deleteFile);
    onClose();
  };

  return (
    <Modal
      title={items.length === 1 ? 'Delete download' : `Delete ${items.length} downloads`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-danger" autoFocus onClick={confirm}>Delete</button>
        </>
      }
    >
      <p>
        {items.length === 1 ? <strong>{items[0].fileName || items[0].url}</strong> : `${items.length} items`} will be
        removed from the list. Unfinished partial data is discarded.
      </p>
      {anyCompleted && (
        <label className="check">
          <input type="checkbox" checked={deleteFile} onChange={(e) => setDeleteFile(e.target.checked)} />
          Also delete completed files from disk
        </label>
      )}
    </Modal>
  );
}
