'use strict';

const http = require('http');

// Minimal file server for tests. Serves `body` on every path except
// /missing (404), with optional range support and per-connection throttling.
async function startFileServer({ body, ranges = true, headers = {}, bytesPerSecond = 0 }) {
  let rangeRequests = 0;
  let bytesSent = 0;

  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/missing')) {
      res.writeHead(404);
      return res.end();
    }
    let start = 0;
    let end = body.length - 1;
    const range = ranges && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const common = { 'Content-Type': 'application/octet-stream', ...headers };
    if (range) {
      rangeRequests++;
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
      res.writeHead(206, {
        ...common,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Content-Length': end - start + 1,
      });
    } else {
      res.writeHead(200, { ...common, 'Content-Length': body.length });
    }

    const rate = typeof bytesPerSecond === 'function' ? bytesPerSecond(start) : bytesPerSecond;
    const chunkSize = 16 * 1024;
    for (let pos = start; pos <= end && !res.destroyed; pos += chunkSize) {
      const chunk = body.subarray(pos, Math.min(end + 1, pos + chunkSize));
      bytesSent += chunk.length;
      if (!res.write(chunk)) {
        await new Promise((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.on('drain', done);
          res.on('close', done);
        });
      }
      if (rate) await new Promise((r) => setTimeout(r, (chunk.length / rate) * 1000));
    }
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: (p) => `http://127.0.0.1:${port}${p}`,
    rangeRequests: () => rangeRequests,
    bytesSent: () => bytesSent,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

async function waitFor(check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timed out waiting for condition');
}

module.exports = { startFileServer, waitFor };
