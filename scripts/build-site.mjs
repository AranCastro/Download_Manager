// Builds the project website into site-dist/ for GitHub Pages:
// - site/ (the landing page) as is;
// - the screenshots and icon from docs/ and build/;
// - demo/: the app's own interface built for the browser, where it runs on
//   the simulated backend (src/mockApi.js), so visitors can try it without
//   installing anything.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = 'site-dist';
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync('site', out, { recursive: true });
fs.mkdirSync(path.join(out, 'img'), { recursive: true });
for (const [from, to] of [
  ['docs/screenshot.png', 'screenshot.png'],
  ['docs/screenshot-dark.png', 'screenshot-dark.png'],
  ['build/icon.png', 'icon.png'],
]) {
  fs.copyFileSync(from, path.join(out, 'img', to));
}

const vite = path.join('node_modules', 'vite', 'bin', 'vite.js');
execFileSync(process.execPath, [vite, 'build', '--outDir', path.join(out, 'demo'), '--emptyOutDir'], { stdio: 'inherit' });
// GitHub Pages would otherwise run the files through Jekyll.
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`built ${out}/`);
