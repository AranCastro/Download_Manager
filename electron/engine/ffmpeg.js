'use strict';

const { spawn } = require('child_process');

// FFmpeg is optional. It is used to merge separate audio/video tracks of a
// stream and to remux MPEG-TS into MP4; without it the raw tracks are kept.

function run(bin, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, signal });
    } catch (err) {
      reject(err);
      return;
    }
    child.stderr?.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.stdout?.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.trim().split('\n').pop()}`));
    });
  });
}

// Returns { path, version } for the first working candidate, or null.
async function findFfmpeg(preferred) {
  // An explicit path is used as given; otherwise FFmpeg is looked up on PATH.
  const candidates = preferred ? [preferred] : ['ffmpeg'];
  for (const bin of candidates) {
    try {
      const version = await new Promise((resolve, reject) => {
        const child = spawn(bin, ['-hide_banner', '-version'], { windowsHide: true });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(out.split('\n')[0]) : reject(new Error(String(code)))));
      });
      return { path: bin, version };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Copies the streams (no re-encoding) into one MP4 file.
function mux(bin, inputs, output, { signal } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const input of inputs) args.push('-i', input);
  if (inputs.length > 1) args.push('-map', '0:v:0?', '-map', '1:a:0?');
  args.push('-c', 'copy', '-movflags', '+faststart', output);
  return run(bin, args, { signal });
}

module.exports = { findFfmpeg, mux };
