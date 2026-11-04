// The app's PNG icons, drawn from public/favicon.svg by Chrome: the small favicons, the iPhone home-screen icon, the
// PWA's (and Home's tile, which takes the manifest's biggest) and the README's logo. Run it after changing the SVG:
//   node tools/make_icons.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CHROME = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error('No Chrome found: set CHROME to one');

const svg = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8');
// the ground (the first rect), then the mark on it
const [, head, tile, mark] = svg.match(/^(<svg[^>]*>)[\s\S]*?(<rect[^>]*\/>)([\s\S]*)<\/svg>\s*$/);
// square to the edge, for icons the device rounds off itself; the mark smaller where it may be cropped to a circle
const square = (scale) => `${head}${tile.replace(/ rx="[^"]*"/, '')}<g transform="translate(24 24) scale(${scale}) translate(-24 -24)">${mark}</g></svg>`;

const ICONS = [
  ['favicon-16.png', 16, svg],
  ['favicon-32.png', 32, svg],
  ['apple-touch-icon.png', 180, square(1)],
  ['pwa-192x192.png', 192, svg],
  ['pwa-512x512.png', 512, svg],
  ['pwa-maskable-512x512.png', 512, square(0.8)],
  ['logo.png', 512, svg],
];

const tmp = mkdtempSync(join(tmpdir(), 'pulse-icons-'));
try {
  for (const [file, size, art] of ICONS) {
    const page = join(tmp, file.replace(/\.png$/, '.svg'));
    writeFileSync(page, art.replace('<svg ', '<svg width="512" height="512" '));
    // Chrome won't make a window much under 500 wide, and lays it out a little wider than asked: the icon drawn
    // 512 wide in the corner, the screenshot of the window's first 512 scaled down to the size
    execFileSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
      '--window-size=512,512', `--force-device-scale-factor=${size / 512}`, `--screenshot=${join(PUBLIC, file)}`,
      pathToFileURL(page).href], { stdio: 'ignore' });
    console.log(file, size, statSync(join(PUBLIC, file)).size, 'bytes');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
