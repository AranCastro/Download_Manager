'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startFileServer, waitFor } = require('./helpers');
const { Scheduler, normaliseSchedule } = require('../electron/engine/Scheduler');
const { DownloadManager } = require('../electron/engine/DownloadManager');

test('scheduler fires start/stop when the times pass, on allowed days only', () => {
  let now = new Date(2026, 9, 19, 1, 59); // Monday 01:59
  let schedule = normaliseSchedule({ enabled: true, startTime: '02:00', stopTime: '06:30', days: [1, 2, 3, 4, 5] });
  const s = new Scheduler(() => schedule, () => now);
  const at = (d, h, m) => new Date(2026, 9, d, h, m);

  assert.deepEqual(s.check(at(19, 2, 0)), ['start']);
  assert.deepEqual(s.check(at(19, 3, 0)), []);
  assert.deepEqual(s.check(at(19, 6, 30)), ['stop']);
  // Asleep from Friday evening to Monday morning: weekend days are skipped,
  // Monday's start fires once.
  s.check(at(23, 20, 0));
  assert.deepEqual(s.check(at(26, 2, 5)), ['start']);
  // Both times passed during one gap: events come in time order.
  s.check(at(26, 23, 0));
  assert.deepEqual(s.check(at(27, 7, 0)), ['start', 'stop']);

  schedule = { ...schedule, enabled: false };
  assert.deepEqual(s.check(at(28, 7, 0)), []);
  assert.equal(normaliseSchedule({ startTime: '7:5' }).startTime, '02:00');
  assert.equal(normaliseSchedule({ startTime: '7:05' }).startTime, '07:05');
});

test('scheduled downloads start in the window and report the after-done action', async (t) => {
  const body = crypto.randomBytes(512 * 1024);
  const server = await startFileServer({ body });
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dm-sched-'));
  const manager = new DownloadManager({
    dataDir: path.join(root, 'data'),
    settings: { downloadDir: path.join(root, 'dl'), schedule: { enabled: true, afterDone: 'quit' } },
  });
  await manager.init({ startScheduler: false });
  t.after(() => server.close());

  const a = manager.add({ url: server.url('/a.bin'), schedule: true });
  const b = manager.add({ url: server.url('/b.bin'), schedule: true });
  const c = manager.add({ url: server.url('/c.bin'), start: false });
  assert.equal(manager.get(a.id).status, 'scheduled');
  manager.schedule([c.id]);

  const finished = new Promise((resolve) => manager.once('schedule-finished', resolve));
  assert.equal(manager.runSchedule(), 3);
  assert.equal(await finished, 'quit');
  for (const d of [a, b, c]) assert.equal(manager.get(d.id).status, 'completed');
  await manager.shutdown();
});

test('closing the window puts scheduler-started downloads back on hold', async (t) => {
  const body = crypto.randomBytes(2 * 1024 * 1024);
  const server = await startFileServer({ body, bytesPerSecond: 256 * 1024 });
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dm-sched-'));
  const manager = new DownloadManager({
    dataDir: path.join(root, 'data'),
    settings: { downloadDir: path.join(root, 'dl'), schedule: { enabled: true, afterDone: 'shutdown' } },
  });
  await manager.init({ startScheduler: false });
  t.after(() => server.close());
  let finishedFired = false;
  manager.on('schedule-finished', () => (finishedFired = true));

  const a = manager.add({ url: server.url('/slow.bin'), schedule: true, connections: 2 });
  manager.runSchedule();
  await waitFor(() => manager.get(a.id).downloadedBytes > 0);
  manager.stopSchedule();
  assert.equal(manager.get(a.id).status, 'scheduled');

  // Quitting during a run never triggers the after-done action.
  manager.runSchedule();
  await waitFor(() => manager.get(a.id).status === 'downloading');
  await manager.shutdown();
  assert.equal(finishedFired, false);
  assert.equal(manager.get(a.id).status, 'scheduled');
});
