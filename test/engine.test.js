'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startFileServer, waitFor } = require('./helpers');
const { DownloadManager } = require('../electron/engine/DownloadManager');
const {
  fileNameFromContentDisposition,
  sanitiseFileName,
  categorise,
  looksLikeDownloadUrl,
} = require('../electron/engine/utils');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function makeManager(settings = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dm-test-'));
  const manager = new DownloadManager({
    dataDir: path.join(root, 'data'),
    settings: { downloadDir: path.join(root, 'downloads'), categoryFolders: false, ...settings },
  });
  await manager.init();
  return { manager, root };
}

const finished = (manager, id) =>
  waitFor(() => {
    const d = manager.get(id);
    if (d.status === 'error') throw new Error(d.error);
    return d.status === 'completed';
  });

test('segmented download reproduces the file byte for byte', async (t) => {
  const body = crypto.randomBytes(5 * 1024 * 1024 + 123);
  const server = await startFileServer({ body, fileName: 'data.bin' });
  const { manager } = await makeManager();
  t.after(() => server.close());

  const added = manager.add({ url: server.url('/files/data.bin'), connections: 8 });
  await finished(manager, added.id);

  const d = manager.get(added.id);
  assert.equal(d.resumable, true);
  assert.equal(d.fileName, 'data.bin');
  assert.equal(sha256(await fsp.readFile(d.savePath)), sha256(body));
  assert.ok(server.rangeRequests() >= 8, 'expected one range request per connection');
  assert.equal(fs.existsSync(d.savePath + '.dmpart'), false);
  await manager.shutdown();
});

test('server without range support falls back to one connection', async (t) => {
  const body = crypto.randomBytes(1024 * 1024);
  const server = await startFileServer({ body, ranges: false });
  const { manager } = await makeManager();
  t.after(() => server.close());

  const added = manager.add({ url: server.url('/plain.zip') });
  await finished(manager, added.id);
  const d = manager.get(added.id);
  assert.equal(d.resumable, false);
  assert.equal(d.category, 'Compressed');
  assert.equal(sha256(await fsp.readFile(d.savePath)), sha256(body));
  await manager.shutdown();
});

test('pause and resume continue from the saved offsets', async (t) => {
  const body = crypto.randomBytes(4 * 1024 * 1024);
  // Throttled so the download is still running when we pause it.
  const server = await startFileServer({ body, bytesPerSecond: 4 * 1024 * 1024 });
  const { manager } = await makeManager();
  t.after(() => server.close());

  const added = manager.add({ url: server.url('/slow.bin'), connections: 4 });
  await waitFor(() => manager.get(added.id).downloadedBytes > 512 * 1024);
  manager.pause(added.id);
  const d = manager.get(added.id);
  assert.equal(d.status, 'paused');
  const offsetAtPause = d.downloadedBytes;
  assert.ok(offsetAtPause < body.length);

  const before = server.bytesSent();
  manager.resume(added.id);
  await finished(manager, added.id);
  assert.equal(sha256(await fsp.readFile(d.savePath)), sha256(body));
  // The resumed transfer must not have re-downloaded the bytes we had.
  assert.ok(server.bytesSent() - before < body.length - offsetAtPause + 256 * 1024);
  await manager.shutdown();
});

test('dynamic segmentation splits a slow segment for idle connections', async (t) => {
  const body = crypto.randomBytes(4 * 1024 * 1024);
  // Requests that start at byte 0 are slow; all others are fast.
  const server = await startFileServer({
    body,
    bytesPerSecond: (start) => (start === 0 ? 512 * 1024 : 0),
  });
  const { manager } = await makeManager();
  t.after(() => server.close());

  const added = manager.add({ url: server.url('/split.bin'), connections: 4 });
  let maxSegments = 0;
  await waitFor(() => {
    const d = manager.get(added.id);
    maxSegments = Math.max(maxSegments, d.segments.length);
    if (d.status === 'error') throw new Error(d.error);
    return d.status === 'completed';
  });
  assert.ok(maxSegments > 4, `expected extra segments, saw ${maxSegments}`);
  assert.equal(sha256(await fsp.readFile(manager.get(added.id).savePath)), sha256(body));
  await manager.shutdown();
});

test('Content-Disposition names the file and duplicates get a suffix', async (t) => {
  const body = Buffer.from('hello world');
  const server = await startFileServer({
    body,
    headers: { 'Content-Disposition': 'attachment; filename="report.pdf"' },
  });
  const { manager } = await makeManager();
  t.after(() => server.close());

  const first = manager.add({ url: server.url('/download?id=1') });
  await finished(manager, first.id);
  const second = manager.add({ url: server.url('/download?id=1') });
  await finished(manager, second.id);

  assert.equal(manager.get(first.id).fileName, 'report.pdf');
  assert.equal(manager.get(second.id).fileName, 'report (1).pdf');
  await manager.shutdown();
});

test('HTTP errors put the download in the error state', async (t) => {
  const server = await startFileServer({ body: Buffer.alloc(10) });
  const { manager } = await makeManager();
  t.after(() => server.close());

  const added = manager.add({ url: server.url('/missing'), start: true });
  await waitFor(() => manager.get(added.id).status === 'error');
  assert.match(manager.get(added.id).error, /404/);
  await manager.shutdown();
});

test('queue respects the concurrency limit and persists across restarts', async (t) => {
  const body = crypto.randomBytes(2 * 1024 * 1024);
  const server = await startFileServer({ body, bytesPerSecond: 2 * 1024 * 1024 });
  const { manager, root } = await makeManager({ maxConcurrent: 1 });
  t.after(() => server.close());

  const a = manager.add({ url: server.url('/a.bin') });
  const b = manager.add({ url: server.url('/b.bin') });
  await waitFor(() => manager.get(a.id).status === 'downloading');
  assert.equal(manager.get(b.id).status, 'queued');
  await manager.shutdown();

  const reopened = new DownloadManager({ dataDir: path.join(root, 'data') });
  await reopened.init();
  assert.deepEqual(reopened.list().map((d) => d.status), ['paused', 'paused']);
  reopened.resumeAll();
  await finished(reopened, a.id);
  await finished(reopened, b.id);
  assert.equal(sha256(await fsp.readFile(reopened.get(b.id).savePath)), sha256(body));
  await reopened.shutdown();
});

test('speed limit slows the transfer down', async (t) => {
  const body = crypto.randomBytes(600 * 1024);
  const server = await startFileServer({ body });
  const { manager } = await makeManager({ speedLimitKBps: 400 });
  t.after(() => server.close());

  const started = Date.now();
  const added = manager.add({ url: server.url('/limited.bin') });
  await finished(manager, added.id);
  const seconds = (Date.now() - started) / 1000;
  assert.ok(seconds >= 1, `600 KB at 400 KB/s took only ${seconds}s`);
  await manager.shutdown();
});

test('helpers', () => {
  assert.equal(fileNameFromContentDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), 'résumé.pdf');
  assert.equal(fileNameFromContentDisposition('inline; filename=plain.txt'), 'plain.txt');
  assert.equal(sanitiseFileName('a<b>:c?.exe'), 'a_b__c_.exe');
  assert.equal(sanitiseFileName('CON.txt'), '_CON.txt');
  assert.equal(categorise('movie.MKV'), 'Video');
  assert.equal(looksLikeDownloadUrl('https://example.org/setup.exe?x=1'), true);
  assert.equal(looksLikeDownloadUrl('https://example.org/page'), false);
});
