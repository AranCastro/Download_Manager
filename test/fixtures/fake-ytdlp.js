'use strict';

// Stand-in for yt-dlp in tests: answers --version and -J like the real tool
// and "downloads" by writing deterministic bytes, printing the same
// DMINFO / DMNAME / DMPROG / DMPOST / DMFILE lines Anabranch asks yt-dlp for.
// Partial files are resumed like yt-dlp's .part files.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const log = (line) => process.env.FAKE_YTDLP_LOG && fs.appendFileSync(process.env.FAKE_YTDLP_LOG, `${line}\n`);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const url = args[args.length - 1];

log(`ARGS ${JSON.stringify(args)}`);

if (args.includes('--version')) {
  console.log('2026.10.01');
  process.exit(0);
}

const cookies = value('--cookies');
if (cookies) log(`COOKIES ${fs.readFileSync(cookies, 'utf8').split('\n').slice(0, 2).join(' / ')}`);

if (/bot/.test(url)) {
  process.stderr.write("ERROR: [youtube] bot123: Sign in to confirm you're not a bot. Use --cookies-from-browser\n");
  process.exit(1);
}

const VIDEO = {
  id: 'abc123',
  title: 'Field Survey | Day 1',
  uploader: 'Geospatial Campus',
  duration: 754,
  thumbnail: 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg',
  filesize_approx: 1310720,
  formats: [
    { format_id: '18', ext: 'mp4', height: 360, width: 640, vcodec: 'avc1', acodec: 'mp4a', tbr: 500 },
    { format_id: '136', ext: 'mp4', height: 720, width: 1280, vcodec: 'avc1', acodec: 'none', tbr: 2500 },
    { format_id: '137', ext: 'mp4', height: 1080, width: 1920, vcodec: 'avc1', acodec: 'none', tbr: 4500 },
    { format_id: '313', ext: 'webm', height: 2160, width: 3840, vcodec: 'vp9', acodec: 'none', tbr: 18000 },
    { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', tbr: 128 },
  ],
};

if (args.includes('-J')) {
  if (/playlist\?list=/.test(url)) {
    console.log(JSON.stringify({
      _type: 'playlist',
      title: 'Remote sensing lectures',
      entries: [
        { id: 'v1', url: 'https://www.youtube.com/watch?v=v1', title: 'Lecture 1', duration: 600 },
        { id: 'v2', url: 'https://www.youtube.com/watch?v=v2', title: 'Lecture 2', duration: 720 },
        { id: 'v3', title: 'Lecture 3', duration: 655 },
      ],
    }));
  } else if (/live/.test(url)) {
    console.log(JSON.stringify({ ...VIDEO, is_live: true }));
  } else {
    console.log(JSON.stringify(VIDEO));
  }
  process.exit(0);
}

// ---- download ----
const dir = value('-P');
const template = value('-o');
const format = value('-f') || '';

// As on YouTube since late 2025: without a working JavaScript runtime the
// single-file formats are missing. Like yt-dlp, the runtime is checked by
// running it with --version in this process's environment.
const runtime = value('--js-runtimes');
let hasRuntime = false;
if (runtime && runtime.startsWith('node:')) {
  try {
    hasRuntime = /^v\d+/.test(execFileSync(runtime.slice(5), ['--version'], { encoding: 'utf8' }));
  } catch {
    hasRuntime = false;
  }
}
log(`RUNTIME ${hasRuntime}`);
if (!hasRuntime && /^b(\[|$)/.test(format)) {
  process.stderr.write('WARNING: [youtube] No supported JavaScript runtime could be found.\n');
  process.stderr.write('ERROR: [youtube] abc123: Requested format is not available. Use --list-formats for a list of available formats\n');
  process.exit(1);
}
const merge = args.includes('--merge-output-format');
const extract = args.includes('-x');
const audioOnly = /^ba/.test(format);
const ext = extract ? 'mp3' : audioOnly ? 'm4a' : 'mp4';
const base = template
  .replace('%(title).150B', VIDEO.title.replace(/\|/g, '_'))
  .replace('%(id)s', VIDEO.id)
  .replace('.%(ext)s', '');
const finalName = path.join(dir, `${base}.${ext}`);
const parts = audioOnly ? [['140', 262144]] : merge ? [['137', 1048576], ['140', 262144]] : [['18', 786432]];
const delay = Number(process.env.FAKE_YTDLP_DELAY || 15);
const byte = (i) => (i * 31 + 7) % 251;

console.log(`DMINFO ${VIDEO.title}|${VIDEO.uploader}|${VIDEO.duration}|${merge ? 1080 : 360}|${VIDEO.id}|NA`);
console.log(`DMNAME ${finalName}`);

(async () => {
  const done = [];
  for (const [id, size] of parts) {
    const part = path.join(dir, `${base}.f${id}.${id === '140' ? 'm4a' : 'mp4'}`);
    const partial = `${part}.part`;
    let have = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    if (fs.existsSync(part)) have = size;
    if (have > 0 && have < size) log(`resumed-from ${have}`);
    const fd = fs.openSync(partial, 'a');
    while (have < size) {
      const n = Math.min(32768, size - have);
      const chunk = Buffer.alloc(n);
      for (let i = 0; i < n; i++) chunk[i] = byte(have + i);
      fs.writeSync(fd, chunk);
      have += n;
      console.log(`DMPROG downloading|${have}|${size}|NA|${id}`);
      await new Promise((r) => setTimeout(r, delay));
    }
    fs.closeSync(fd);
    if (fs.existsSync(partial)) fs.renameSync(partial, part);
    console.log(`DMPROG finished|${size}|${size}|NA|${id}`);
    done.push(part);
  }
  console.log('DMPOST started|Merger');
  fs.writeFileSync(finalName, Buffer.concat(done.map((p) => fs.readFileSync(p))));
  for (const p of done) fs.rmSync(p);
  console.log('DMPOST finished|Merger');
  console.log(`DMFILE ${finalName}`);
})();
