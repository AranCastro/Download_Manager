// Development: starts the Vite dev server, then Electron pointed at it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

await build({
  entryPoints: ['mcp/server.mjs'],
  outfile: 'dist-mcp/anabranch-mcp.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'warning',
});

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`Renderer dev server: ${url}`);

const electron = spawn(require('electron'), ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
electron.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
