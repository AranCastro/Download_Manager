'use strict';

const http = require('http');
const crypto = require('crypto');

// Local REST API used by the MCP server (and any other local tool). It binds
// to 127.0.0.1 only and every request must carry the bearer token, which is
// written to <userData>/api.json for local clients to discover.
//
//   GET    /api/downloads                list
//   POST   /api/downloads                add {url, fileName?, directory?, connections?, start?}
//   GET    /api/downloads/:id            one download
//   POST   /api/downloads/:id/pause      pause
//   POST   /api/downloads/:id/resume     resume / retry
//   DELETE /api/downloads/:id?deleteFile=true
//   POST   /api/pause-all, /api/resume-all
//   GET    /api/settings, PATCH /api/settings
function createApiServer(manager, { token }) {
  const expected = Buffer.from(`Bearer ${token}`);

  const authorised = (req) => {
    const given = Buffer.from(req.headers.authorization || '');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };

  const routes = [
    ['GET', /^\/api\/downloads$/, () => manager.list()],
    ['POST', /^\/api\/downloads$/, (_m, body) => manager.add(body)],
    ['GET', /^\/api\/downloads\/([\w-]+)$/, ([, id]) => manager.get(id).snapshot()],
    ['POST', /^\/api\/downloads\/([\w-]+)\/pause$/, ([, id]) => manager.pause(id)],
    ['POST', /^\/api\/downloads\/([\w-]+)\/resume$/, ([, id]) => manager.resume(id)],
    [
      'DELETE',
      /^\/api\/downloads\/([\w-]+)$/,
      async ([, id], _body, query) => {
        await manager.remove(id, { deleteFile: query.get('deleteFile') === 'true' });
        return { removed: id };
      },
    ],
    ['POST', /^\/api\/pause-all$/, () => (manager.pauseAll(), manager.list())],
    ['POST', /^\/api\/resume-all$/, () => (manager.resumeAll(), manager.list())],
    ['GET', /^\/api\/settings$/, () => manager.settings],
    ['PATCH', /^\/api\/settings$/, (_m, body) => manager.updateSettings(body)],
  ];

  return http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };

    // Browsers attach an Origin header; web pages have no business here.
    if (req.headers.origin) return send(403, { error: 'Cross-origin requests are not allowed' });
    if (!authorised(req)) return send(401, { error: 'Missing or invalid API token' });

    const url = new URL(req.url, 'http://127.0.0.1');
    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
    if (!route) return send(404, { error: 'Not found' });

    try {
      const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const result = await route[2](route[1].exec(url.pathname), body, url.searchParams);
      send(200, result);
    } catch (err) {
      send(err.message?.startsWith('No download') ? 404 : 400, { error: err.message });
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Listens on the preferred port, falling back to the next free one.
function listen(server, preferredPort, attempts = 10) {
  return new Promise((resolve, reject) => {
    let port = preferredPort;
    const tryListen = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && --attempts > 0) {
          port += 1;
          tryListen();
        } else reject(err);
      });
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        resolve(server.address().port);
      });
    };
    tryListen();
  });
}

module.exports = { createApiServer, listen };
