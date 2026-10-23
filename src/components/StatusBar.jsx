import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { formatSpeed } from '../format.js';

const PRESETS = [0, 256, 512, 1024, 2048, 5120, 10240];
const label = (kb) => (kb === 0 ? 'Unlimited' : kb >= 1024 ? `${(kb / 1024).toFixed(kb % 1024 ? 1 : 0)} MB/s` : `${kb} KB/s`);

function SpeedLimit({ value }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  const set = (kb) => {
    api.updateSettings({ speedLimitKBps: kb });
    setOpen(false);
  };
  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className={`chip ${value ? 'chip-warn' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="gauge" size={14} /> {value ? `Limit ${label(value)}` : 'No speed limit'}
      </button>
      {open && (
        <div className="popover" role="menu">
          <div className="popover-title">Speed limit</div>
          {PRESETS.map((kb) => (
            <button key={kb} type="button" role="menuitemradio" aria-checked={value === kb} className={value === kb ? 'is-on' : ''} onClick={() => set(kb)}>
              {label(kb)}
              {value === kb && <Icon name="check" size={14} />}
            </button>
          ))}
          <form
            className="popover-custom"
            onSubmit={(e) => {
              e.preventDefault();
              const kb = Math.max(0, Math.round(Number(custom)));
              if (Number.isFinite(kb)) set(kb);
            }}
          >
            <input type="number" min="0" placeholder="Custom KB/s" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <button type="submit" className="btn btn-small">Set</button>
          </form>
        </div>
      )}
    </div>
  );
}

export function StatusBar({ counts, settings, totalSpeed, isMock, onScheduler }) {
  const schedule = settings?.schedule;
  return (
    <footer className="statusbar">
      <span className="status-counts">
        <span className={counts.active ? 'live-dot' : ''}>{counts.active} active</span>
        {counts.queued > 0 && <span>{counts.queued} queued</span>}
        {counts.scheduled > 0 && <span>{counts.scheduled} scheduled</span>}
        <span>{counts.total} total</span>
      </span>
      <span className="statusbar-right">
        {isMock && <span className="chip">Browser preview</span>}
        {schedule?.enabled && (
          <button type="button" className="chip" onClick={onScheduler}>
            <Icon name="calendar" size={14} /> {schedule.startTime}
            {schedule.stopTime ? `–${schedule.stopTime}` : ''}
          </button>
        )}
        {settings && <SpeedLimit value={settings.speedLimitKBps} />}
        <span className="total-speed">
          <Icon name="download" size={14} /> {formatSpeed(totalSpeed) || 'Idle'}
        </span>
      </span>
    </footer>
  );
}
