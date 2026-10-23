'use strict';

const http = require('http');
const crypto = require('crypto');

// Local REST API used by the MCP server and the browser extension. It binds
// to 127.0.0.1 only. Requests from web pages (an Origin that is not a
// browser extension) are refused, and every route except /api/ping and
// /api/pair needs a bearer token: the app token in <userData>/api.json, or a
// token issued to a browser extension the user approved.
//
//   GET    /api/ping                     app presence (and whether the token is valid)
//   POST   /api/pair                     extension asks the user for a token {browser}
//   GET    /api/downloads                list
//   POST   /api/downloads                add {url, fileName?, directory?, connections?, start?,
//                                         schedule?, kind?, quality?, headers?, username?, password?}
//   POST   /api/prompt                   open the Add dialog in the app {items: [{url, ...}]}
//   GET    /api/downloads/:id            one download
//   POST   /api/downloads/:id/pause      pause
//   POST   /api/downloads/:id/resume     resume / retry
//   POST   /api/downloads/:id/schedule   move to the scheduled queue
//   POST   /api/downloads/:id/credentials  {username, password, remember?}
//   DELETE /api/downloads/:id?deleteFile=true
//   POST   /api/pause-all, /api/resume-all
//   GET    /api/settings, PATCH /api/settings
//   GET    /api/scheduler, PATCH /api/scheduler, POST /api/scheduler/run

const EXTENSION_ORIGIN = /^(chrome|moz|ms-browser|safari-web)-extension:\/\//i;

function createApiServer(manager, { token, isPairedToken = () => false, onPair, onPrompt, version = '1.0.0' }) {
  const expected = Buffer.from(token);

  const tokenValid = (req) => {
    const match = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
    if (!match) return false;
    const given = Buffer.from(match[1]);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return true;
    return isPairedToken(match[1]);
  };

  const id = '([\\w-]+)';
  const routes = [
    ['GET', '/api/downloads', () => manager.list()],
    ['POST', '/api/downloads', (_m, body) => manager.add(body)],
    [
      'POST',
      '/api/prompt',
      (_m, body) => {
        const items = (Array.isArray(body.items) ? body.items : [body]).filter((i) => i && i.url);
        if (!items.length) throw new Error('No URLs given');
        if (!onPrompt) throw new Error('Prompting is not available');
        onPrompt(items);
        return { prompted: items.length };
      },
    ],
    ['GET', `/api/downloads/${id}`, ([, d]) => manager.get(d).snapshot()],
    ['POST', `/api/downloads/${id}/pause`, ([, d]) => manager.pause(d)],
    ['POST', `/api/downloads/${id}/resume`, ([, d]) => manager.resume(d)],
    ['POST', `/api/downloads/${id}/schedule`, ([, d]) => manager.schedule([d])[0]],
    ['POST', `/api/downloads/${id}/credentials`, ([, d], body) => manager.setCredentials(d, body)],
    [
      'DELETE',
      `/api/downloads/${id}`,
      async ([, d], _body, query) => {
        await manager.remove(d, { deleteFile: query.get('deleteFile') === 'true' });
        return { removed: d };
      },
    ],
    ['POST', '/api/pause-all', () => (manager.pauseAll(), manager.list())],
    ['POST', '/api/resume-all', () => (manager.resumeAll(), manager.list())],
    ['GET', '/api/settings', () => manager.settings],
    ['PATCH', '/api/settings', (_m, body) => manager.updateSettings(body)],
    ['GET', '/api/scheduler', () => manager.settings.schedule],
    ['PATCH', '/api/scheduler', async (_m, body) => (await manager.updateSettings({ schedule: body })).schedule],
    ['POST', '/api/scheduler/run', () => ({ started: manager.runSchedule() })],
  ].map(([method, pattern, handler]) => [method, new RegExp(`^${pattern}$`), handler]);

  return http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };

    const origin = req.headers.origin;
    if (origin && !EXTENSION_ORIGIN.test(origin)) {
      return send(403, { error: 'Requests from web pages are not allowed' });
    }
    const url = new URL(req.url, 'http://127.0.0.1');

    try {
      if (req.method === 'GET' && url.pathname === '/api/ping') {
        return send(200, { app: 'download-manager', version, authorised: tokenValid(req) });
      }
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        if (!onPair) return send(404, { error: 'Pairing is not available' });
        const body = await readBody(req);
        const issued = await onPair({ origin: origin || null, browser: String(body.browser || 'Browser').slice(0, 60) });
        return issued ? send(200, { token: issued }) : send(403, { error: 'The connection was declined in Download Manager' });
      }

      if (!tokenValid(req)) return send(401, { error: 'Missing or invalid API token' });
      const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
      if (!route) return send(404, { error: 'Not found' });
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

module.exports = { createApiServer, listen, EXTENSION_ORIGIN };
