'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { FtpSrv } = require('ftp-srv');
const bunyan = require('bunyan');
const { startRouteServer, sendBody, waitFor } = require('./helpers');
const { DownloadManager } = require('../electron/engine/DownloadManager');
const { parseChallenge } = require('../electron/engine/http');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

async function makeManager(settings = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dm-auth-'));
  const manager = new DownloadManager({
    dataDir: path.join(root, 'data'),
    settings: { downloadDir: path.join(root, 'downloads'), categoryFolders: false, ...settings },
  });
  await manager.init({ startScheduler: false });
  return { manager, root };
}

const status = (manager, id, wanted) =>
  waitFor(() => {
    const d = manager.get(id);
    if (d.status === 'error' && wanted !== 'error') throw new Error(d.error);
    return d.status === wanted;
  });

test('Basic auth: asks for a login, then completes with the saved one', async (t) => {
  const body = crypto.randomBytes(1024 * 1024);
  const expected = `Basic ${Buffer.from('aran:secret').toString('base64')}`;
  const server = await startRouteServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Data portal"' });
      return res.end();
    }
    sendBody(req, res, body);
  });
  const { manager, root } = await makeManager();
  t.after(() => server.close());

  const added = manager.add({ url: server.url('/protected/dem.zip') });
  await status(manager, added.id, 'auth-required');
  assert.match(manager.get(added.id).error, /Data portal/);

  await manager.setCredentials(added.id, { username: 'aran', password: 'wrong' });
  await status(manager, added.id, 'auth-required');
  assert.match(manager.get(added.id).error, /rejected/);

  await manager.setCredentials(added.id, { username: 'aran', password: 'secret', remember: true });
  await status(manager, added.id, 'completed');
  assert.equal(sha256(await fsp.readFile(manager.get(added.id).savePath)), sha256(body));

  // "Remember for this site" applies to the next download from the same host.
  const second = manager.add({ url: server.url('/protected/other.zip') });
  await status(manager, second.id, 'completed');

  // Passwords are not written to downloads.json.
  await manager.shutdown();
  const saved = await fsp.readFile(path.join(root, 'data', 'downloads.json'), 'utf8');
  assert.equal(saved.includes('secret'), false);
});

test('Digest auth (RFC 7616, qop=auth) and credentials in the URL', async (t) => {
  const body = crypto.randomBytes(700 * 1024);
  const realm = 'archive';
  const nonce = crypto.randomBytes(8).toString('hex');
  const server = await startRouteServer((req, res) => {
    const header = req.headers.authorization || '';
    const p = parseChallenge(header.replace(/^Digest /, 'Digest '))?.params || {};
    const ha1 = md5(`user:${realm}:pa ss`);
    const ha2 = md5(`GET:${p.uri}`);
    const valid =
      header.startsWith('Digest ') &&
      p.uri === req.url &&
      p.response === md5(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    if (!valid) {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", algorithm=MD5` });
      return res.end();
    }
    sendBody(req, res, body);
  });
  const { manager } = await makeManager();
  t.after(() => server.close());

  const url = server.url('/files/scan.tif').replace('http://', 'http://user:pa%20ss@');
  const added = manager.add({ url, connections: 4 });
  assert.equal(added.url.includes('pa%20ss'), false, 'credentials must be removed from the URL');
  await status(manager, added.id, 'completed');
  assert.equal(sha256(await fsp.readFile(manager.get(added.id).savePath)), sha256(body));
  await manager.shutdown();
});

async function startFtp(root, { users } = {}) {
  const port = 21000 + Math.floor(Math.random() * 2000);
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: '127.0.0.1',
    pasv_min: 31000,
    pasv_max: 31999,
    anonymous: !users,
    log: bunyan.createLogger({ name: 'ftp-test', level: 'fatal' }),
  });
  server.on('login', ({ username, password }, resolve, reject) => {
    if (users && users[username] !== password) return reject(new Error('Login incorrect'));
    resolve({ root });
  });
  await server.listen();
  return { url: (p) => `ftp://127.0.0.1:${port}${p}`, close: () => server.close() };
}

test('FTP: segmented download over several connections, then resume', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dm-ftp-'));
  const body = crypto.randomBytes(3 * 1024 * 1024 + 77);
  await fsp.writeFile(path.join(root, 'landsat scene.tar'), body);
  const server = await startFtp(root);
  const { manager } = await makeManager();
  t.after(() => server.close());

  const added = manager.add({ url: server.url('/landsat%20scene.tar'), connections: 4 });
  await waitFor(() => manager.get(added.id).downloadedBytes > 0);
  manager.pause(added.id);
  const segments = manager.get(added.id).segments.length;
  assert.ok(segments >= 4, `expected 4+ FTP segments, got ${segments}`);
  manager.resume(added.id);
  let maxActive = 0;
  await waitFor(() => {
    const snap = manager.get(added.id).snapshot();
    maxActive = Math.max(maxActive, snap.activeConnections);
    return snap.status === 'completed';
  });
  assert.ok(maxActive > 1, `expected parallel FTP connections, saw ${maxActive}`);

  const d = manager.get(added.id);
  assert.equal(d.fileName, 'landsat scene.tar');
  assert.equal(d.resumable, true);
  assert.equal(sha256(await fsp.readFile(d.savePath)), sha256(body));
  await manager.shutdown();
});

test('FTP: login required, then succeeds with credentials', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dm-ftp-'));
  const body = crypto.randomBytes(400 * 1024);
  await fsp.writeFile(path.join(root, 'report.pdf'), body);
  const server = await startFtp(root, { users: { surveyor: 'k3y' } });
  const { manager } = await makeManager();
  t.after(() => server.close());

  const added = manager.add({ url: server.url('/report.pdf') });
  await status(manager, added.id, 'auth-required');
  await manager.setCredentials(added.id, { username: 'surveyor', password: 'k3y' });
  await status(manager, added.id, 'completed');
  assert.equal(sha256(await fsp.readFile(manager.get(added.id).savePath)), sha256(body));
  assert.equal(fs.existsSync(manager.get(added.id).savePath + '.dmpart'), false);
  await manager.shutdown();
});

test('parseChallenge prefers Digest and reads quoted values', () => {
  const c = parseChallenge('Basic realm="a", Digest realm="b, c", nonce="xyz", qop="auth,auth-int"');
  assert.equal(c.scheme, 'digest');
  assert.equal(c.params.realm, 'b, c');
  assert.equal(c.params.qop, 'auth,auth-int');
});
