'use strict';

const { EventEmitter } = require('events');

const DEFAULT_SCHEDULE = {
  enabled: false,
  startTime: '02:00',
  stopTime: '',
  days: [0, 1, 2, 3, 4, 5, 6],
  afterDone: 'nothing',
};

const AFTER_DONE = ['nothing', 'quit', 'sleep', 'shutdown'];
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function normaliseSchedule(input = {}) {
  const s = { ...DEFAULT_SCHEDULE, ...input };
  const time = (value, fallback) => {
    const m = TIME.exec(String(value || '').trim());
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : fallback;
  };
  return {
    enabled: Boolean(s.enabled),
    startTime: time(s.startTime, DEFAULT_SCHEDULE.startTime),
    stopTime: time(s.stopTime, ''),
    days: [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort(),
    afterDone: AFTER_DONE.includes(s.afterDone) ? s.afterDone : 'nothing',
  };
}

// Occurrences of hh:mm (local time) on the allowed weekdays within (from, to].
function occurrences(from, to, hhmm, days) {
  if (!hhmm) return [];
  const [h, m] = hhmm.split(':').map(Number);
  const out = [];
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i < 9 && day <= to; i++) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
    if (at > from && at <= to && days.includes(at.getDay())) out.push(at);
    day.setDate(day.getDate() + 1);
  }
  return out;
}

// Emits 'start' and 'stop' when the configured times pass. check() is
// called on a timer; it compares against the previous check, so a missed
// tick (sleeping laptop) still fires once, in time order.
class Scheduler extends EventEmitter {
  constructor(getSchedule, now = () => new Date()) {
    super();
    this.getSchedule = getSchedule;
    this.now = now;
    this.last = now();
    this.timer = null;
  }

  start(intervalMs = 10000) {
    this.last = this.now();
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  check(now = this.now()) {
    const previous = this.last;
    this.last = now;
    const s = this.getSchedule();
    if (!s.enabled || now <= previous) return [];
    const events = [
      ...occurrences(previous, now, s.startTime, s.days).map((at) => ({ at, type: 'start' })),
      ...occurrences(previous, now, s.stopTime, s.days).map((at) => ({ at, type: 'stop' })),
    ].sort((a, b) => a.at - b.at);
    for (const e of events) this.emit(e.type);
    return events.map((e) => e.type);
  }
}

module.exports = { Scheduler, DEFAULT_SCHEDULE, normaliseSchedule, AFTER_DONE };
