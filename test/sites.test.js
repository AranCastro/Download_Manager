'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { waitFor } = require('./helpers');
const { DownloadManager } = require('../electron/engine/DownloadManager');
const {
  isSiteUrl,
  formatArgs,
  parseLine,
  parseProbe,
  describeFailure,
  cookieFile,
} = require('../electron/engine/sites/ytdlp');

const FAKE = path.join(__dirname, 'fixtures', 'fake-ytdlp.js');
const WATCH = 'https://www.youtube.com/watch?v=abc123';
const byte = (i) => (i * 31 + 7) % 251;

async function makeManager({ ffmpeg = { path: path.resolve('/fake/ffmpeg'), version: 'fake' }, ytdlp = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dm-site-'));
  const logFile = path.join(root, 'ytdlp.log');
  process.env.FAKE_YTDLP_LOG = logFile;
  const manager = new DownloadManager({
    dataDir: path.join(root, 'data'),
    settings: { downloadDir: path.join(root, 'dl'), ytDlpPath: path.join(root, 'missing-yt-dlp') },
    tools: { ffmpeg, ...(ytdlp ? { ytdlp: { command: process.execPath, args: [FAKE] } } : {}) },
  });
  await manager.init({ startScheduler: false });
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
  return { manager, root, log };
}

const completed = (manager, id) =>
  waitFor(() => {
    const d = manager.get(id);
    if (d.status === 'error') throw new Error(d.error);
    return d.status === 'completed';
  }, 30000);

// Expected bytes of the fake's parts, concatenated in download order.
function expectedBytes(sizes) {
  const parts = sizes.map((size) => Buffer.from(Array.from({ length: size }, (_, i) => byte(i))));
  return Buffer.concat(parts);
}

test('YouTube URLs are recognised and yt-dlp output is parsed', () => {
  for (const url of [WATCH, 'https://youtu.be/abc123', 'https://m.youtube.com/shorts/x', 'https://music.youtube.com/watch?v=1']) {
    assert.equal(isSiteUrl(url), true, url);
  }
  assert.equal(isSiteUrl('https://example.org/video.mp4'), false);

  assert.deepEqual(formatArgs('720', true), ['-f', 'bv*+ba/b', '-S', 'res:720,ext:mp4:m4a', '--merge-output-format', 'mp4']);
  assert.deepEqual(formatArgs('best', false), ['-f', 'b']);
  assert.deepEqual(formatArgs('mp3', true).slice(-4), ['-x', '--audio-format', 'mp3', '--audio-quality', '0'].slice(-4));

  const info = parseLine('DMINFO Field Survey | Day 1|Geospatial Campus|754|1080|abc123|NA');
  assert.equal(info.title, 'Field Survey | Day 1');
  assert.equal(info.height, 1080);
  assert.deepEqual(parseLine('DMPROG downloading|500|1000|NA|137'), {
    type: 'DMPROG', status: 'downloading', downloaded: 500, total: 1000, formatId: '137',
  });
  assert.equal(parseLine('[download] 50%'), null);

  assert.match(describeFailure("ERROR: [youtube] x: Sign in to confirm you're not a bot"), /browser extension/);
  const noFormat = 'ERROR: [youtube] x: Requested format is not available. Use --list-formats';
  assert.match(describeFailure(noFormat, { hasFfmpeg: false }), /Install FFmpeg/);
  assert.match(describeFailure(noFormat), /Update yt-dlp/);
  assert.match(describeFailure('ERROR: unable to download video data: HTTP Error 403: Forbidden'), /HTTP 403/);
  const jar = cookieFile('SID=abc; HSID=def', WATCH);
  assert.match(jar, /^# Netscape HTTP Cookie File\n\.youtube\.com\tTRUE\t\/\tTRUE\t0\tSID\tabc\n/);

  const probe = parseProbe({ _type: 'playlist', title: 'P', entries: [{ id: 'q1', title: 'One' }] }, 'https://www.youtube.com/playlist?list=1');
  assert.equal(probe.entries[0].url, 'https://www.youtube.com/watch?v=q1');
});

test('probe shows title, channel, duration and the qualities on offer', async () => {
  const { manager } = await makeManager();
  const info = await manager.probe({ url: WATCH });
  assert.equal(info.kind, 'site');
  assert.equal(info.site, 'YouTube');
  assert.equal(info.title, 'Field Survey | Day 1');
  assert.equal(info.uploader, 'Geospatial Campus');
  assert.equal(info.duration, 754);
  assert.deepEqual(info.qualities.map((q) => q.height), [2160, 1080, 720, 360]);

  const playlist = await manager.probe({ url: 'https://www.youtube.com/playlist?list=PL1' });
  assert.equal(playlist.playlist.count, 3);
  assert.deepEqual(playlist.entries.map((e) => e.title), ['Lecture 1', 'Lecture 2', 'Lecture 3']);

  const bot = await manager.probe({ url: 'https://www.youtube.com/watch?v=bot' });
  assert.match(bot.error, /not a bot/);
  const live = await manager.probe({ url: 'https://www.youtube.com/watch?v=live' });
  assert.match(live.error, /Live/);
  await manager.shutdown();
});

test('without yt-dlp the probe asks for the one-click install', async () => {
  const { manager } = await makeManager({ ytdlp: false });
  const info = await manager.probe({ url: WATCH });
  assert.equal(info.toolMissing, 'ytdlp');
  const added = manager.add({ url: WATCH });
  await waitFor(() => manager.get(added.id).status === 'error');
  assert.match(manager.get(added.id).error, /yt-dlp is not installed/);
  await manager.shutdown();
});

test('video and audio streams are merged into one MP4 in the Video folder', async () => {
  const { manager, log } = await makeManager();
  const added = manager.add({ url: WATCH, quality: '1080' });
  assert.equal(added.kind, 'site');
  await completed(manager, added.id);
  const d = manager.get(added.id);
  assert.equal(path.basename(d.savePath), 'Field Survey _ Day 1 [abc123].mp4');
  assert.equal(path.basename(path.dirname(d.savePath)), 'Video');
  assert.deepEqual(await fsp.readFile(d.savePath), expectedBytes([1048576, 262144]));
  assert.equal(d.siteInfo.uploader, 'Geospatial Campus');
  assert.match(log(), /"-S","res:1080,ext:mp4:m4a"/);
  const download = [...log().matchAll(/^ARGS (.*)$/gm)].map((m) => JSON.parse(m[1])).find((a) => a.includes('-P'));
  assert.equal(download[download.indexOf('--ffmpeg-location') + 1], path.dirname(path.resolve('/fake/ffmpeg')));
  assert.equal(fs.readdirSync(path.dirname(d.savePath)).length, 1, 'no partial files left');
  await manager.shutdown();
});

test('without FFmpeg a single-file format is used', async () => {
  const { manager, log } = await makeManager({ ffmpeg: null });
  const added = manager.add({ url: WATCH });
  await completed(manager, added.id);
  assert.deepEqual(await fsp.readFile(manager.get(added.id).savePath), expectedBytes([786432]));
  assert.match(log(), /"-f","b"/);
  // The single-file formats need the JavaScript runtime the app passes on.
  assert.match(log(), /"--js-runtimes","node:/);
  assert.match(log(), /^RUNTIME true$/m);
  assert.doesNotMatch(log(), /merge-output-format/);
  await manager.shutdown();
});

test('pause stops yt-dlp and resume continues the partial file', async () => {
  process.env.FAKE_YTDLP_DELAY = '40';
  const { manager, log } = await makeManager();
  const added = manager.add({ url: WATCH, quality: '1080' });
  await waitFor(() => manager.get(added.id).downloadedBytes > 200000);
  manager.pause(added.id);
  const d = manager.get(added.id);
  assert.equal(d.status, 'paused');
  const dir = path.dirname(d.partBase);
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.part')), 'partial file kept');
  manager.resume(added.id);
  await completed(manager, added.id);
  delete process.env.FAKE_YTDLP_DELAY;
  assert.match(log(), /resumed-from \d+/);
  assert.deepEqual(await fsp.readFile(d.savePath), expectedBytes([1048576, 262144]));
  await manager.shutdown();
});

test('MP3 audio goes to the Music folder; browser cookies reach yt-dlp', async () => {
  const { manager, log } = await makeManager();
  const added = manager.add({ url: WATCH, quality: 'mp3', headers: { Cookie: 'SID=s3cret; PREF=f1' } });
  assert.equal(added.category, 'Music');
  await completed(manager, added.id);
  const d = manager.get(added.id);
  assert.equal(path.extname(d.savePath), '.mp3');
  assert.equal(path.basename(path.dirname(d.savePath)), 'Music');
  assert.match(log(), /"-x","--audio-format","mp3"/);
  assert.match(log(), /COOKIES # Netscape HTTP Cookie File \/ \.youtube\.com\tTRUE\t\/\tTRUE\t0\tSID\ts3cret/);
  // The temporary cookie file is deleted afterwards.
  const cookiePath = JSON.parse(log().match(/ARGS (.*"--cookies".*)/)[1]).find((a) => a.includes('anabranch-cookies'));
  assert.equal(fs.existsSync(cookiePath), false);
  await manager.shutdown();
});

test('the app updates its own yt-dlp at most once a day', async () => {
  const { manager, log } = await makeManager();
  const first = await manager.updateYtDlp();
  assert.deepEqual(first, { version: '2026.10.20', before: '2026.10.01' });
  assert.match(log(), /"-U"/);
  assert.deepEqual(await manager.updateYtDlp(), { skipped: 'recent' });
  assert.equal((await manager.toolStatus()).ytdlp.version, '2026.10.20');
  await manager.shutdown();
});

test('deleting an unfinished video removes its partial files', async () => {
  process.env.FAKE_YTDLP_DELAY = '40';
  const { manager } = await makeManager();
  const added = manager.add({ url: WATCH, quality: '1080' });
  await waitFor(() => manager.get(added.id).downloadedBytes > 100000);
  manager.pause(added.id);
  const dir = path.dirname(manager.get(added.id).partBase);
  await manager.remove(added.id);
  delete process.env.FAKE_YTDLP_DELAY;
  assert.deepEqual(fs.readdirSync(dir), []);
  await manager.shutdown();
});
