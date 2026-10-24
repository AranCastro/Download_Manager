import { useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export function ContextMenu({ x, y, download, selectionSize, actions, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - r.width - 8),
      top: Math.min(y, window.innerHeight - r.height - 8),
    });
  }, [x, y]);

  if (!download) return null;
  const single = selectionSize <= 1;
  const run = (fn) => () => {
    fn();
    onClose();
  };
  const isDone = download.status === 'completed';
  const canResume = ['paused', 'error', 'scheduled'].includes(download.status);
  const canStop = ['queued', 'connecting', 'downloading', 'merging'].includes(download.status);
  const canSchedule = !isDone && download.status !== 'scheduled';

  return (
    <div className="menu" ref={ref} style={pos} role="menu" onClick={(e) => e.stopPropagation()}>
      {single && isDone && <button role="menuitem" onClick={run(() => api.openFile(download.id))}>Open</button>}
      {single && <button role="menuitem" onClick={run(() => api.showInFolder(download.id))}>Open folder</button>}
      {(canResume || !single) && <button role="menuitem" onClick={run(actions.resume)}>Resume</button>}
      {(canStop || !single) && <button role="menuitem" onClick={run(actions.stop)}>Stop</button>}
      {(canSchedule || !single) && <button role="menuitem" onClick={run(actions.schedule)}>Add to schedule</button>}
      {single && download.status === 'auth-required' && (
        <button role="menuitem" onClick={run(actions.login)}>Log in…</button>
      )}
      {single && <button role="menuitem" onClick={run(() => api.copy(download.url))}>Copy address</button>}
      <hr />
      <button role="menuitem" className="danger" onClick={run(actions.remove)}>
        Delete{selectionSize > 1 ? ` ${selectionSize} items` : ''}…
      </button>
    </div>
  );
}
