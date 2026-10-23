#!/usr/bin/env node
// MCP server (stdio) for Download Manager.
//
// It forwards tool calls to the running desktop app through its local REST
// API. The API address and token are read from DM_API_URL / DM_API_TOKEN, or
// from the api.json file the app writes to its user-data folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const APP_FOLDER = 'Download Manager';

function apiFileCandidates() {
  if (process.env.DM_API_FILE) return [process.env.DM_API_FILE];
  const home = os.homedir();
  return [
    process.env.APPDATA && path.join(process.env.APPDATA, APP_FOLDER, 'api.json'),
    path.join(home, 'Library', 'Application Support', APP_FOLDER, 'api.json'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_FOLDER, 'api.json'),
  ].filter(Boolean);
}

// Read on every call: the app may have restarted on a different port.
function apiConfig() {
  if (process.env.DM_API_URL && process.env.DM_API_TOKEN) {
    return { url: process.env.DM_API_URL.replace(/\/$/, ''), token: process.env.DM_API_TOKEN };
  }
  for (const file of apiFileCandidates()) {
    try {
      const { port, token } = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { url: `http://127.0.0.1:${port}`, token };
    } catch {
      // try the next location
    }
  }
  throw new Error(
    'Download Manager is not running (no api.json found). Start the desktop app and try again.',
  );
}

async function api(method, route, body) {
  const { url, token } = apiConfig();
  let res;
  try {
    res = await fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Cannot reach Download Manager at ${url}. Is the desktop app running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Download Manager API returned HTTP ${res.status}`);
  return data;
}

function formatBytes(bytes) {
  if (bytes == null) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// A compact view of a download for the model to read.
function summarise(d) {
  const percent = d.totalBytes ? Math.floor((d.downloadedBytes / d.totalBytes) * 100) : null;
  return {
    id: d.id,
    fileName: d.fileName,
    status: d.status,
    progress: percent == null ? formatBytes(d.downloadedBytes) : `${percent}%`,
    size: formatBytes(d.totalBytes),
    downloaded: formatBytes(d.downloadedBytes),
    speed: d.speed ? `${formatBytes(d.speed)}/s` : undefined,
    etaSeconds: d.eta == null ? undefined : Math.round(d.eta),
    connections: d.activeConnections || undefined,
    category: d.category,
    savePath: d.savePath,
    url: d.url,
    error: d.error || undefined,
  };
}

const reply = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

// Wraps a handler so API errors come back as tool errors, not protocol errors.
const tool = (handler) => async (args) => {
  try {
    return reply(await handler(args));
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
};

const server = new McpServer({ name: 'download-manager', version: '1.0.0' });

const STATUSES = ['queued', 'connecting', 'downloading', 'paused', 'completed', 'error'];

server.registerTool(
  'add_download',
  {
    title: 'Add download',
    description:
      'Queue an http(s) URL in Download Manager. The file is split across several ' +
      'connections when the server supports range requests. Returns the new download.',
    inputSchema: {
      url: z.string().url().describe('Direct http(s) link to the file'),
      fileName: z.string().optional().describe('Save as this name instead of the server-provided one'),
      directory: z.string().optional().describe('Absolute folder to save into (default: app setting)'),
      connections: z.number().int().min(1).max(32).optional().describe('Parallel connections (1-32)'),
      start: z.boolean().optional().describe('Start immediately (default true) or add paused'),
    },
  },
  tool(async (args) => summarise(await api('POST', '/api/downloads', args))),
);

server.registerTool(
  'list_downloads',
  {
    title: 'List downloads',
    description: 'List downloads with status, progress, speed and save location.',
    inputSchema: {
      status: z.enum(STATUSES).optional().describe('Only return downloads with this status'),
    },
  },
  tool(async ({ status }) => {
    const all = await api('GET', '/api/downloads');
    return all.filter((d) => !status || d.status === status).map(summarise);
  }),
);

server.registerTool(
  'get_download',
  {
    title: 'Get download',
    description: 'Detailed state of one download, including each connection segment.',
    inputSchema: { id: z.string().describe('Download id') },
  },
  tool(async ({ id }) => {
    const d = await api('GET', `/api/downloads/${encodeURIComponent(id)}`);
    return {
      ...summarise(d),
      resumable: d.resumable,
      segments: d.segments.map((s) => ({
        from: s.start,
        to: s.end,
        downloaded: formatBytes(s.downloaded),
        active: s.active,
      })),
    };
  }),
);

server.registerTool(
  'pause_download',
  {
    title: 'Pause download',
    description: 'Pause (stop) a download. Resumable downloads continue where they stopped.',
    inputSchema: { id: z.string() },
  },
  tool(async ({ id }) => summarise(await api('POST', `/api/downloads/${encodeURIComponent(id)}/pause`))),
);

server.registerTool(
  'resume_download',
  {
    title: 'Resume download',
    description: 'Resume a paused download or retry a failed one.',
    inputSchema: { id: z.string() },
  },
  tool(async ({ id }) => summarise(await api('POST', `/api/downloads/${encodeURIComponent(id)}/resume`))),
);

server.registerTool(
  'remove_download',
  {
    title: 'Remove download',
    description:
      'Remove a download from the list. Partial data is always deleted; set deleteFile ' +
      'to also delete a completed file from disk.',
    inputSchema: { id: z.string(), deleteFile: z.boolean().optional() },
    annotations: { destructiveHint: true },
  },
  tool(async ({ id, deleteFile }) =>
    api('DELETE', `/api/downloads/${encodeURIComponent(id)}?deleteFile=${deleteFile === true}`),
  ),
);

server.registerTool(
  'pause_all',
  { title: 'Pause all', description: 'Pause every running or queued download.', inputSchema: {} },
  tool(async () => (await api('POST', '/api/pause-all')).map(summarise)),
);

server.registerTool(
  'resume_all',
  { title: 'Resume all', description: 'Resume every paused or failed download.', inputSchema: {} },
  tool(async () => (await api('POST', '/api/resume-all')).map(summarise)),
);

server.registerTool(
  'get_settings',
  { title: 'Get settings', description: 'Read Download Manager settings.', inputSchema: {} },
  tool(() => api('GET', '/api/settings')),
);

server.registerTool(
  'update_settings',
  {
    title: 'Update settings',
    description: 'Change download folder, concurrency, connections or the speed limit.',
    inputSchema: {
      downloadDir: z.string().optional().describe('Default download folder'),
      categoryFolders: z.boolean().optional().describe('Sort files into Video, Music, ... sub-folders'),
      maxConcurrent: z.number().int().min(1).max(20).optional().describe('Downloads running at once'),
      connections: z.number().int().min(1).max(32).optional().describe('Default connections per download'),
      speedLimitKBps: z.number().int().min(0).optional().describe('Total speed limit in KB/s; 0 = unlimited'),
    },
  },
  tool((patch) => api('PATCH', '/api/settings', patch)),
);

server
  .connect(new StdioServerTransport())
  .catch((err) => {
    console.error('Download Manager MCP server failed to start:', err);
    process.exit(1);
  });
