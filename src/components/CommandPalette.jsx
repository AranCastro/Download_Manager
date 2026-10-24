import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../icons.jsx';
import { STATUS_LABELS } from '../format.js';

// Ctrl+K: run any command or jump to a download by typing part of its name.
export function CommandPalette({ commands, downloads, onPickDownload, onClose }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef(null);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (text) => words.every((w) => text.toLowerCase().includes(w));
    const cmds = commands.filter((c) => !c.disabled && match(`${c.label} ${c.keywords || ''}`)).map((c) => ({ type: 'command', ...c }));
    const dls = words.length
      ? downloads.filter((d) => match(`${d.fileName} ${d.url}`)).slice(0, 8).map((d) => ({ type: 'download', id: d.id, label: d.fileName || d.url, hint: STATUS_LABELS[d.status], icon: d.category, d }))
      : [];
    return [...cmds, ...dls];
  }, [query, commands, downloads]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const run = (item) => {
    onClose();
    if (item.type === 'command') item.run();
    else onPickDownload(item.d);
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && results[index]) {
      e.preventDefault();
      run(results[index]);
    } else if (e.key === 'Escape') onClose();
  };

  let lastType = null;
  return (
    <div className="overlay overlay-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="command" size={17} />
          <input autoFocus placeholder="Type a command or a file name…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} aria-label="Command" />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {results.map((item, i) => {
            const heading = item.type !== lastType ? (item.type === 'command' ? 'Commands' : 'Downloads') : null;
            lastType = item.type;
            return (
              <div key={`${item.type}-${item.id || item.label}`}>
                {heading && <div className="palette-heading">{heading}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  className={`palette-item ${i === index ? 'is-active' : ''}`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => run(item)}
                >
                  <Icon name={item.icon || 'bolt'} size={16} />
                  <span>{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                </button>
              </div>
            );
          })}
          {!results.length && <p className="palette-empty">No matching commands or downloads.</p>}
        </div>
      </div>
    </div>
  );
}
