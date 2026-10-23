import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const { DownloadManager } = require('../electron/engine/DownloadManager.js');
const { createApiServer, listen } = require('../electron/api-server.js');
const { startFileServer, waitFor } = require('./helpers.js');

// Runs the bundled server when it has been built, otherwise the source.
const bundled = path.resolve('dist-mcp/download-manager-mcp.cjs');
const serverScript = fs.existsSync(bundled) ? bundled : path.resolve('mcp/server.mjs');

const parse = (result) => JSON.parse(result.content[0].text);

test('MCP tools drive the download manager through the local API', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dm-mcp-'));
  const manager = new DownloadManager({
    dataDir: path.join(root, 'data'),
    settings: { downloadDir: path.join(root, 'downloads') },
  });
  await manager.init();
  const token = crypto.randomBytes(16).toString('hex');
  const api = createApiServer(manager, { token });
  const port = await listen(api, 0);
  const body = crypto.randomBytes(2 * 1024 * 1024);
  const files = await startFileServer({ body });

  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverScript],
      env: { ...process.env, DM_API_URL: `http://127.0.0.1:${port}`, DM_API_TOKEN: token },
    }),
  );
  t.after(async () => {
    await client.close();
    await manager.shutdown();
    api.close();
    await files.close();
  });

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((x) => x.name).sort(),
    [
      'add_download', 'get_download', 'get_settings', 'list_downloads', 'pause_all',
      'pause_download', 'remove_download', 'resume_all', 'resume_download', 'update_settings',
    ],
  );

  const added = parse(
    await client.callTool({ name: 'add_download', arguments: { url: files.url('/video.mp4') } }),
  );
  await waitFor(() => manager.get(added.id).status === 'completed');

  const listed = parse(await client.callTool({ name: 'list_downloads', arguments: { status: 'completed' } }));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].fileName, 'video.mp4');
  assert.equal(listed[0].category, 'Video');
  assert.equal(listed[0].progress, '100%');

  const settings = parse(
    await client.callTool({ name: 'update_settings', arguments: { speedLimitKBps: 512, maxConcurrent: 2 } }),
  );
  assert.equal(settings.speedLimitKBps, 512);
  assert.equal(manager.limiter.rate, 512 * 1024);

  const bad = await client.callTool({ name: 'get_download', arguments: { id: 'nope' } });
  assert.equal(bad.isError, true);

  await client.callTool({ name: 'remove_download', arguments: { id: added.id, deleteFile: true } });
  assert.equal(manager.list().length, 0);
  assert.equal(fs.existsSync(listed[0].savePath), false);
});

test('API rejects requests without the token or from web pages', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dm-api-'));
  const manager = await new DownloadManager({ dataDir: root }).init();
  const api = createApiServer(manager, { token: 'secret' });
  const port = await listen(api, 0);
  t.after(async () => {
    await manager.shutdown();
    api.close();
  });

  const url = `http://127.0.0.1:${port}/api/downloads`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { headers: { Authorization: 'Bearer secret', Origin: 'https://evil.example' } })).status,
    403,
  );
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer secret' } })).status, 200);
});
