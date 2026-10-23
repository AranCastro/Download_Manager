// Bundles the MCP server and its dependencies into one CommonJS file so the
// installed app can run it with its own Electron runtime (no Node install).
import { build } from 'esbuild';

await build({
  entryPoints: ['mcp/server.mjs'],
  outfile: 'dist-mcp/download-manager-mcp.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'info',
});
