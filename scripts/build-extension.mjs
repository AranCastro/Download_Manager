// Builds the browser extension for Chromium browsers (Manifest V3) and
// Firefox (Manifest V2) into dist-extension/, plus a zip of each.
import fs from 'node:fs';
import path from 'node:path';
import { zipDirectory } from './zip.mjs';

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const source = 'browser-extension';
const out = 'dist-extension';
const files = ['background.js', 'youtube.js', 'popup.html', 'popup.js', 'popup.css', 'icons'];
const icons = Object.fromEntries([16, 32, 48, 128].map((s) => [s, `icons/icon-${s}.png`]));

const common = {
  name: 'Anabranch Browser Connector',
  short_name: 'Anabranch',
  version,
  description:
    'Sends downloads, links, YouTube videos and detected video streams (HLS/DASH) to the Anabranch desktop app.',
  icons,
  content_scripts: [
    { matches: ['https://www.youtube.com/*', 'https://m.youtube.com/*'], js: ['youtube.js'], run_at: 'document_idle' },
  ],
};

const manifests = {
  chromium: {
    manifest_version: 3,
    ...common,
    minimum_chrome_version: '116',
    permissions: ['downloads', 'contextMenus', 'cookies', 'storage', 'scripting', 'webRequest', 'webNavigation'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'background.js' },
    action: { default_popup: 'popup.html', default_title: 'Anabranch', default_icon: icons },
  },
  firefox: {
    manifest_version: 2,
    ...common,
    permissions: ['downloads', 'contextMenus', 'cookies', 'storage', 'webRequest', 'webNavigation', 'tabs', '<all_urls>'],
    background: { scripts: ['background.js'] },
    browser_action: { default_popup: 'popup.html', default_title: 'Anabranch', default_icon: icons },
    browser_specific_settings: {
      gecko: { id: 'anabranch@draran.online', strict_min_version: '115.0', data_collection_permissions: { required: ['none'] } },
    },
  },
};

fs.rmSync(out, { recursive: true, force: true });
for (const [target, manifest] of Object.entries(manifests)) {
  const dir = path.join(out, target);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) fs.cpSync(path.join(source, file), path.join(dir, file), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // The zips are what users load or submit to the browser stores.
  const zip = path.join(out, `anabranch-extension-${target}-${version}.zip`);
  zipDirectory(dir, zip);
  console.log(`built ${dir} and ${path.relative('.', zip)}`);
}
