'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { startRouteServer, sendBody, waitFor } = require('./helpers');
const { DownloadManager } = require('../electron/engine/DownloadManager');
const { resolveDashManifest, parseDuration } = require('../electron/engine/streams/dash');
const { parsePlaylist, selectVariant } = require('../electron/engine/streams/hls');

const has = (bin) => {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const HAS_FFMPEG = has('ffmpeg') && has('ffprobe');

async function makeManager(settings = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dm-stream-'));
  const manager = new DownloadManager({
    dataDir: path.join(root, 'data'),
    settings: { downloadDir: path.join(root, 'dl'), categoryFolders: true, ...settings },
  });
  await manager.init({ startScheduler: false });
  return manager;
}

const completed = (manager, id) =>
  waitFor(() => {
    const d = manager.get(id);
    if (['error', 'auth-required'].includes(d.status)) throw new Error(d.error);
    return d.status === 'completed';
  }, 60000);

function encrypt(data, key, iv) {
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

function sequenceIv(n) {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(n), 8);
  return iv;
}

// Two-variant HLS stream: the 720p variant has six AES-128 segments (IV from
// the media sequence) followed by six clear ones.
function syntheticHls() {
  const key = crypto.randomBytes(16);
  const hi = Array.from({ length: 12 }, () => crypto.randomBytes(40 * 1024 + 13));
  const lo = Array.from({ length: 12 }, () => crypto.randomBytes(10 * 1024));
  const routes = new Map();
  routes.set('/v/master.m3u8', [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'lo/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
    'hi/index.m3u8',
  ].join('\n'));
  const media = (dir, encryptFirst) => {
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:5', '#EXT-X-PLAYLIST-TYPE:VOD'];
    if (encryptFirst) lines.push('#EXT-X-KEY:METHOD=AES-128,URI="/keys/k1"');
    for (let i = 0; i < 12; i++) {
      if (encryptFirst && i === 6) lines.push('#EXT-X-KEY:METHOD=NONE');
      lines.push('#EXTINF:2.0,', `seg${i}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
  };
  routes.set('/v/hi/index.m3u8', media('hi', true));
  routes.set('/v/lo/index.m3u8', media('lo', false));
  routes.set('/keys/k1', key);
  hi.forEach((seg, i) => routes.set(`/v/hi/seg${i}.ts`, i < 6 ? encrypt(seg, key, sequenceIv(5 + i)) : seg));
  lo.forEach((seg, i) => routes.set(`/v/lo/seg${i}.ts`, seg));
  return { routes, hi, lo };
}

const serveRoutes = (routes) =>
  startRouteServer((req, res) => {
    const body = routes.get(new URL(req.url, 'http://x').pathname);
    if (body == null) {
      res.writeHead(404);
      return res.end();
    }
    sendBody(req, res, Buffer.isBuffer(body) ? body : Buffer.from(body));
  });

test('HLS: best variant, AES-128 decryption, saved as .ts without FFmpeg', async (t) => {
  const { routes, hi } = syntheticHls();
  const server = await serveRoutes(routes);
  const manager = await makeManager({ ffmpegPath: '/nonexistent/ffmpeg' });
  t.after(() => server.close());

  const added = manager.add({ url: server.url('/v/master.m3u8'), fileName: 'Lecture 3: Remote Sensing' });
  assert.equal(added.kind, 'hls');
  await completed(manager, added.id);

  const d = manager.get(added.id);
  assert.equal(path.basename(d.savePath), 'Lecture 3_ Remote Sensing.ts');
  assert.equal(path.basename(path.dirname(d.savePath)), 'Video');
  assert.deepEqual(await fsp.readFile(d.savePath), Buffer.concat(hi));
  assert.equal(d.streamInfo.height, 720);
  assert.equal(fs.existsSync(`${d.savePath}.dmparts`), false);
  await manager.shutdown();
});

test('HLS: quality preference picks the matching variant', async (t) => {
  const { routes, lo } = syntheticHls();
  const server = await serveRoutes(routes);
  const manager = await makeManager({ ffmpegPath: '/nonexistent/ffmpeg' });
  t.after(() => server.close());

  const added = manager.add({ url: server.url('/v/master.m3u8'), quality: '480' });
  await completed(manager, added.id);
  assert.deepEqual(await fsp.readFile(manager.get(added.id).savePath), Buffer.concat(lo));
  await manager.shutdown();
});

test('HLS: separate audio rendition is kept as a second file without FFmpeg', async (t) => {
  const video = [crypto.randomBytes(9000), crypto.randomBytes(9000)];
  const audio = [crypto.randomBytes(3000), crypto.randomBytes(3000)];
  const media = (names) =>
    ['#EXTM3U', ...names.flatMap((n) => ['#EXTINF:4,', n]), '#EXT-X-ENDLIST'].join('\n');
  const routes = new Map([
    [
      '/s/master.m3u8',
      [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="aud"',
        'video/main.m3u8',
      ].join('\n'),
    ],
    ['/s/video/main.m3u8', media(['v0.ts', 'v1.ts'])],
    ['/s/audio/en.m3u8', media(['a0.aac', 'a1.aac'])],
    ['/s/video/v0.ts', video[0]],
    ['/s/video/v1.ts', video[1]],
    ['/s/audio/a0.aac', audio[0]],
    ['/s/audio/a1.aac', audio[1]],
  ]);
  const server = await serveRoutes(routes);
  const manager = await makeManager({ ffmpegPath: '/nonexistent/ffmpeg' });
  t.after(() => server.close());

  const added = manager.add({ url: server.url('/s/master.m3u8') });
  await completed(manager, added.id);
  const d = manager.get(added.id);
  assert.equal(path.basename(d.savePath), 's.ts');
  assert.deepEqual(await fsp.readFile(d.savePath), Buffer.concat(video));
  assert.equal(d.extraFiles.length, 1);
  assert.match(d.extraFiles[0], /s\.audio\.aac$/);
  assert.deepEqual(await fsp.readFile(d.extraFiles[0]), Buffer.concat(audio));
  assert.match(d.note, /FFmpeg/);
  await manager.shutdown();
});

test('HLS: live and DRM-protected streams are refused with a clear message', async (t) => {
  const routes = new Map([
    ['/live.m3u8', '#EXTM3U\n#EXTINF:2,\na.ts\n'],
    ['/drm.m3u8', '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n'],
  ]);
  const server = await serveRoutes(routes);
  const manager = await makeManager();
  t.after(() => server.close());
  const live = manager.add({ url: server.url('/live.m3u8') });
  const drm = manager.add({ url: server.url('/drm.m3u8') });
  await waitFor(() => manager.get(live.id).status === 'error' && manager.get(drm.id).status === 'error');
  assert.match(manager.get(live.id).error, /Live/);
  assert.match(manager.get(drm.id).error, /DRM/);
  await manager.shutdown();
});

test('DASH manifest: templates, timelines, segment lists, live and DRM', () => {
  const base = 'https://cdn.example.org/vod/film/manifest.mpd';
  const templated = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%05d$.m4s" duration="4000" startNumber="1"/>
      <Representation id="v480" bandwidth="900000" width="854" height="480"/>
      <Representation id="v1080" bandwidth="4500000" width="1920" height="1080"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000">
        <SegmentTemplate timescale="48000" initialization="audio/init.mp4" media="audio/$Time$.m4s">
          <SegmentTimeline><S t="0" d="96000" r="-1"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const plan = resolveDashManifest(templated, base);
  const [video, audio] = plan.tracks;
  assert.equal(plan.info.height, 1080);
  assert.equal(video.init.uri, 'https://cdn.example.org/vod/film/v1080/init.mp4');
  assert.equal(video.segments.length, 3);
  assert.equal(video.segments[2].uri, 'https://cdn.example.org/vod/film/v1080/seg-00003.m4s');
  assert.equal(audio.segments.length, 5);
  assert.equal(audio.segments[4].uri, 'https://cdn.example.org/vod/film/audio/384000.m4s');
  assert.equal(audio.ext, '.m4a');
  assert.equal(resolveDashManifest(templated, base, '720').info.height, 480);

  const list = `<MPD type="static" mediaPresentationDuration="PT2S"><BaseURL>https://media.example.org/x/</BaseURL><Period>
    <AdaptationSet mimeType="video/webm"><Representation id="1" bandwidth="1"><BaseURL>clip.webm</BaseURL>
      <SegmentList><Initialization range="0-99"/><SegmentURL mediaRange="100-199"/><SegmentURL mediaRange="200-299"/></SegmentList>
    </Representation></AdaptationSet></Period></MPD>`;
  const single = resolveDashManifest(list, base).tracks[0];
  assert.equal(single.type, 'main');
  assert.equal(single.ext, '.webm');
  assert.deepEqual(single.init, { uri: 'https://media.example.org/x/clip.webm', byteRange: { offset: 0, length: 100 } });
  assert.deepEqual(single.segments[1].byteRange, { offset: 200, length: 100 });

  assert.throws(() => resolveDashManifest('<MPD type="dynamic"><Period/></MPD>', base), /Live/);
  const drm = templated.replace('<Representation id="v480"', '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/><Representation id="v480"');
  assert.throws(() => resolveDashManifest(drm, base), /DRM/);
  assert.equal(parseDuration('PT1H2M3.5S'), 3723.5);
});

test('HLS parsing helpers', () => {
  const master = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x240,CODECS="a,b"\nx.m3u8\n', 'https://h/p/m.m3u8');
  assert.equal(master.variants[0].uri, 'https://h/p/x.m3u8');
  assert.equal(master.variants[0].codecs, 'a,b');
  const media = parsePlaylist(
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\n#EXT-X-BYTERANGE:500@0\nall.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:300\nall.mp4\n#EXT-X-ENDLIST',
    'https://h/p/m.m3u8',
  );
  assert.deepEqual(media.segments[1].byteRange, { length: 300, offset: 500 });
  assert.equal(media.segments[0].map.uri, 'https://h/p/init.mp4');
  assert.equal(selectVariant([{ bandwidth: 1, height: 360 }, { bandwidth: 2, height: 1080 }], 'worst').height, 360);
});

// Real media produced by FFmpeg, served over HTTP, downloaded and checked
// with ffprobe. Skipped where FFmpeg is not installed.
function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file]);
  const json = JSON.parse(out);
  return { types: json.streams.map((s) => s.codec_type).sort(), duration: Number(json.format.duration) };
}

async function ffmpegFixtures() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dm-media-'));
  const input = ['-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4'];
  const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-shortest'];
  await fsp.mkdir(path.join(dir, 'hls'));
  await fsp.writeFile(path.join(dir, 'hls', 'enc.key'), crypto.randomBytes(16));
  await fsp.writeFile(path.join(dir, 'keyinfo'), `enc.key\n${path.join(dir, 'hls', 'enc.key')}\n`);
  execFileSync('ffmpeg', ['-v', 'error', ...input, ...enc, '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_key_info_file', path.join(dir, 'keyinfo'), path.join(dir, 'hls', 'index.m3u8')]);
  await fsp.mkdir(path.join(dir, 'dash'));
  execFileSync('ffmpeg', ['-v', 'error', ...input, ...enc, '-f', 'dash', '-seg_duration', '1', '-use_template', '1', '-use_timeline', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a', path.join(dir, 'dash', 'manifest.mpd')]);
  const server = await startRouteServer(async (req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    sendBody(req, res, await fsp.readFile(file));
  });
  return { server };
}

test('real HLS (AES-128) and DASH streams are merged into playable MP4 with FFmpeg', { skip: !HAS_FFMPEG && 'FFmpeg not installed' }, async (t) => {
  const { server } = await ffmpegFixtures();
  const manager = await makeManager();
  t.after(() => server.close());

  const hls = manager.add({ url: server.url('/hls/index.m3u8'), fileName: 'hls clip' });
  const dash = manager.add({ url: server.url('/dash/manifest.mpd'), fileName: 'dash clip' });
  await completed(manager, hls.id);
  await completed(manager, dash.id);

  for (const id of [hls.id, dash.id]) {
    const d = manager.get(id);
    assert.equal(path.extname(d.savePath), '.mp4');
    const info = probe(d.savePath);
    assert.deepEqual(info.types, ['audio', 'video']);
    assert.ok(Math.abs(info.duration - 4) < 0.6, `duration ${info.duration}`);
    assert.equal(d.note, null);
  }
  await manager.shutdown();
});

test('real DASH without FFmpeg keeps playable video and audio files', { skip: !HAS_FFMPEG && 'FFmpeg not installed' }, async (t) => {
  const { server } = await ffmpegFixtures();
  const manager = await makeManager({ ffmpegPath: '/nonexistent/ffmpeg' });
  t.after(() => server.close());

  const dash = manager.add({ url: server.url('/dash/manifest.mpd'), fileName: 'clip' });
  await completed(manager, dash.id);
  const d = manager.get(dash.id);
  assert.deepEqual(probe(d.savePath).types, ['video']);
  assert.deepEqual(probe(d.extraFiles[0]).types, ['audio']);
  await manager.shutdown();
});

test('probe reports stream qualities and duration, file size, and login needs', async (t) => {
  const { routes } = syntheticHls();
  routes.set('/files/report.pdf', crypto.randomBytes(5000));
  const server = await serveRoutes(routes);
  const secure = await startRouteServer((req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Portal"' });
    res.end();
  });
  const manager = await makeManager();
  t.after(async () => {
    await server.close();
    await secure.close();
  });

  const hls = await manager.probe({ url: server.url('/v/master.m3u8') });
  assert.deepEqual(hls.qualities.map((q) => q.height), [720, 360]);
  assert.equal(hls.duration, 24);
  assert.equal(hls.segments, 12);
  assert.equal(hls.kind, 'hls');

  const file = await manager.probe({ url: server.url('/files/report.pdf') });
  assert.deepEqual(
    { name: file.fileName, size: file.totalBytes, resumable: file.resumable, category: file.category },
    { name: 'report.pdf', size: 5000, resumable: true, category: 'Documents' },
  );

  const locked = await manager.probe({ url: secure.url('/dem.tif') });
  assert.equal(locked.authRequired, true);
  assert.equal(locked.realm, 'Portal');

  const missing = await manager.probe({ url: server.url('/nope.zip') });
  assert.match(missing.error, /404/);
  assert.equal(manager.list().length, 0);
  await manager.shutdown();
});
