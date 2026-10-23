import { useState } from 'react';
import { api } from '../api.js';
import { Modal } from './Modal.jsx';

const DAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
];

const AFTER_DONE = [
  ['nothing', 'Do nothing'],
  ['quit', 'Close Download Manager'],
  ['sleep', 'Put the computer to sleep'],
  ['shutdown', 'Shut down the computer'],
];

export function SchedulerDialog({ settings, scheduledCount, onClose }) {
  const [draft, setDraft] = useState(settings.schedule);
  const [useStop, setUseStop] = useState(Boolean(settings.schedule.stopTime));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const toggleDay = (day) =>
    set('days', draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day]);

  const save = async () => {
    await api.updateSettings({ schedule: { ...draft, stopTime: useStop ? draft.stopTime || '06:00' : '' } });
    onClose();
  };

  const runNow = async () => {
    await api.runSchedule();
    onClose();
  };

  return (
    <Modal
      title="Scheduler"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={!scheduledCount} onClick={runNow}>
            Start {scheduledCount || ''} now
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save}>Save</button>
        </>
      }
    >
      <p className="muted">
        {scheduledCount
          ? `${scheduledCount} download${scheduledCount > 1 ? 's are' : ' is'} waiting in the scheduled queue.`
          : 'No downloads are scheduled. Use “Schedule” in the Add dialog or the right-click menu.'}
      </p>
      <label className="check">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        Start scheduled downloads automatically
      </label>
      <fieldset className="fieldset" disabled={!draft.enabled}>
        <div className="grid-2">
          <label className="field">
            <span>Start at</span>
            <input type="time" value={draft.startTime} onChange={(e) => set('startTime', e.target.value)} />
          </label>
          <div className="field">
            <label className="check inline">
              <input type="checkbox" checked={useStop} onChange={(e) => setUseStop(e.target.checked)} />
              <span>Stop at</span>
            </label>
            <input
              type="time"
              disabled={!useStop}
              value={draft.stopTime || '06:00'}
              onChange={(e) => set('stopTime', e.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <span>On these days</span>
          <div className="days">
            {DAYS.map(([day, label]) => (
              <label key={day} className={`day ${draft.days.includes(day) ? 'is-on' : ''}`}>
                <input type="checkbox" checked={draft.days.includes(day)} onChange={() => toggleDay(day)} />
                {label}
              </label>
            ))}
          </div>
        </div>
        <label className="field">
          <span>When the scheduled downloads finish</span>
          <select value={draft.afterDone} onChange={(e) => set('afterDone', e.target.value)}>
            {AFTER_DONE.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <small>A 60-second countdown is shown first, so the action can be cancelled.</small>
        </label>
      </fieldset>
    </Modal>
  );
}
