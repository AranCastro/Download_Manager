import { useEffect } from 'react';
import { Icon } from '../icons.jsx';

const ICONS = { success: 'checkCircle', error: 'alert', info: 'info' };

function Toast({ toast, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), { error: 10000, success: 7000 }[toast.kind] || 4000);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);
  return (
    <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      <Icon name={ICONS[toast.kind]} size={18} />
      <div className="toast-body">
        <strong>{toast.title}</strong>
        {toast.body && <span className="ellipsis" title={toast.body}>{toast.body}</span>}
        {toast.actions?.length > 0 && (
          <div className="toast-actions">
            {toast.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="link-btn"
                onClick={() => {
                  a.run();
                  onDismiss(toast.id);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="icon-btn" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export function Toasts({ toasts, onDismiss }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
