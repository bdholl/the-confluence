// HTML → image, with the Chrome that's already installed. GitHub's Ubuntu
// runners ship Google Chrome, and a Mac has it in /Applications, so the cards
// render with the site's real fonts and no npm dependencies.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const p = which(c);
    if (p) return p;
  }
  throw new Error('No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.');
}

// PNG width/height live at fixed offsets in the IHDR chunk.
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function screenshot(html, { width, height, out }) {
  const chrome = findChrome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-card-'));
  const page = path.join(dir, 'card.html');
  fs.writeFileSync(page, html);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-component-update', '--disable-sync',
    '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    // give Google Fonts time to arrive before the shutter
    '--virtual-time-budget=8000',
    `--user-data-dir=${path.join(dir, 'profile')}`,
    `--screenshot=${out}`, `file://${page}`,
  ], { encoding: 'utf8', timeout: 90000 });
  fs.rmSync(dir, { recursive: true, force: true });
  if (!fs.existsSync(out)) throw new Error(`Chrome did not write a screenshot (exit ${r.status}): ${(r.stderr || '').slice(-400)}`);
  const got = pngSize(out);
  if (got.width !== width || got.height !== height) {
    throw new Error(`Card rendered at ${got.width}×${got.height}, expected ${width}×${height}`);
  }
  return out;
}

// Instagram only accepts JPEG. sips on a Mac, ImageMagick on the runner.
function toJpeg(png, jpg, quality = 90) {
  const tools = [
    ['sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), png, '--out', jpg]],
    ['magick', [png, '-quality', String(quality), jpg]],
    ['convert', [png, '-quality', String(quality), jpg]],
  ];
  for (const [cmd, args] of tools) {
    if (!which(cmd)) continue;
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(jpg)) return jpg;
  }
  throw new Error('No PNG→JPEG converter found (need sips or ImageMagick).');
}

module.exports = { findChrome, screenshot, toJpeg, pngSize };
