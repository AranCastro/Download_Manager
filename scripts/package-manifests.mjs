// Writes package-manager manifests for the release built in release/:
// - release/anabranch.json: a Scoop manifest for the portable exe, so that
//   `scoop install <release URL>/anabranch.json` works for every version;
// - release/anabranch-winget-<version>.zip: the three winget manifests for
//   the installer, ready to submit to microsoft/winget-pkgs.
// Run after electron-builder (the CI workflow does this on every build).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { zipDirectory } from './zip.mjs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const { version } = pkg;
const REPO = 'https://github.com/AranCastro/Download_Manager';
const download = (file) => `${REPO}/releases/download/v${version}/${file}`;
const setup = `Anabranch-Setup-${version}.exe`;
const portable = `Anabranch-Portable-${version}.exe`;
const out = 'release';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(out, file))).digest('hex');
for (const file of [setup, portable]) {
  if (!fs.existsSync(path.join(out, file))) throw new Error(`${file} not found in ${out}/; build the Windows targets first`);
}

const SHORT = 'Multi-connection download manager with FTP, HLS/DASH, YouTube, a scheduler, a browser extension and an MCP server.';
const LONG =
  'Anabranch splits each download into parallel connections and resumes after interruptions. It supports HTTP, FTP and FTPS, ' +
  'HLS and DASH video streams, YouTube through yt-dlp, scheduled downloads, sign-in prompts, a browser extension for Chrome, ' +
  'Edge and Firefox, and a Model Context Protocol (MCP) server through which AI assistants such as Claude can queue and control downloads.';

// ---- Scoop ----------------------------------------------------------------
const scoop = {
  version,
  description: SHORT,
  homepage: REPO,
  license: 'MIT',
  url: `${download(portable)}#/Anabranch.exe`,
  hash: sha256(portable),
  bin: 'Anabranch.exe',
  shortcuts: [['Anabranch.exe', 'Anabranch']],
  checkver: { github: REPO },
  autoupdate: { url: `${REPO}/releases/download/v$version/Anabranch-Portable-$version.exe#/Anabranch.exe` },
};
fs.writeFileSync(path.join(out, 'anabranch.json'), `${JSON.stringify(scoop, null, 2)}\n`);

// ---- winget -----------------------------------------------------------------
// Schema 1.10.0 is accepted by the winget-pkgs validation pipeline; check
// with `winget validate --manifest <folder>` before submitting.
const ID = 'AranCastro.Anabranch';
const MANIFEST_VERSION = '1.10.0';
const header = (type) =>
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${MANIFEST_VERSION}.schema.json\n`;
const yaml = (entries) =>
  entries
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}:\n${value.map((v) => `- ${v}`).join('\n')}`;
      return `${key}: ${value}`;
    })
    .join('\n');

const wingetDir = path.join(out, 'winget', 'manifests', 'a', 'AranCastro', 'Anabranch', version);
fs.rmSync(path.join(out, 'winget'), { recursive: true, force: true });
fs.mkdirSync(wingetDir, { recursive: true });

fs.writeFileSync(
  path.join(wingetDir, `${ID}.yaml`),
  `${header('version')}\n${yaml([
    ['PackageIdentifier', ID],
    ['PackageVersion', version],
    ['DefaultLocale', 'en-US'],
    ['ManifestType', 'version'],
    ['ManifestVersion', MANIFEST_VERSION],
  ])}\n`,
);

fs.writeFileSync(
  path.join(wingetDir, `${ID}.installer.yaml`),
  `${header('installer')}\n${yaml([
    ['PackageIdentifier', ID],
    ['PackageVersion', version],
    ['InstallerType', 'nullsoft'],
    ['Scope', 'user'],
    ['InstallModes', ['interactive', 'silent', 'silentWithProgress']],
    ['UpgradeBehavior', 'install'],
    ['ReleaseDate', new Date().toISOString().slice(0, 10)],
  ])}
Installers:
- Architecture: x64
  InstallerUrl: ${download(setup)}
  InstallerSha256: ${sha256(setup).toUpperCase()}
${yaml([
    ['ManifestType', 'installer'],
    ['ManifestVersion', MANIFEST_VERSION],
  ])}\n`,
);

fs.writeFileSync(
  path.join(wingetDir, `${ID}.locale.en-US.yaml`),
  `${header('defaultLocale')}\n${yaml([
    ['PackageIdentifier', ID],
    ['PackageVersion', version],
    ['PackageLocale', 'en-US'],
    ['Publisher', 'Dr Aran Castro'],
    ['PublisherUrl', 'https://github.com/AranCastro'],
    ['PublisherSupportUrl', `${REPO}/issues`],
    ['Author', 'Dr Aran Castro'],
    ['PackageName', 'Anabranch'],
    ['PackageUrl', REPO],
    ['License', 'MIT'],
    ['LicenseUrl', `${REPO}/blob/main/LICENSE`],
    ['ShortDescription', SHORT],
    ['Description', LONG],
    ['Moniker', 'anabranch'],
    ['Tags', ['download-manager', 'downloader', 'ftp', 'hls', 'mcp', 'yt-dlp']],
    ['ReleaseNotesUrl', `${REPO}/releases/tag/v${version}`],
    ['ManifestType', 'defaultLocale'],
    ['ManifestVersion', MANIFEST_VERSION],
  ])}\n`,
);

zipDirectory(path.join(out, 'winget'), path.join(out, `anabranch-winget-${version}.zip`));
console.log(`wrote ${out}/anabranch.json and ${out}/anabranch-winget-${version}.zip`);
