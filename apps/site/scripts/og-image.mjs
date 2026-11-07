// Renders scripts/og-card.html (1200x630) to public/og.png with headless Chrome. Run it after changing the card:
//   npm run og            (set CHROME=/path/to/chrome if Chrome is not in the default macOS or Linux location)
// The result is committed; the site's <meta property="og:image"> points at /og.png.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const card = fileURLToPath(new URL('./og-card.html', import.meta.url));
const out = fileURLToPath(new URL('../public/og.png', import.meta.url));
const candidates = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const chrome = candidates.find((path) => existsSync(path));
if (!chrome) throw new Error('Chrome not found; set CHROME to its path');
rmSync(out, { force: true });
// A throwaway profile keeps Chrome's crash reporter and your own profile out of it. Chrome sometimes exits non-zero from its shutdown
// watchdog after the screenshot is written, so success is judged by the file, not the exit code.
const profile = mkdtempSync(join(tmpdir(), 'slurp-og-'));
const run = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1200,630', '--allow-file-access-from-files', `--user-data-dir=${profile}`, `--screenshot=${out}`, `file://${card}`], { encoding: 'utf8', timeout: 60_000 });
rmSync(profile, { recursive: true, force: true });
if (!existsSync(out) || statSync(out).size < 10_000) throw new Error(`Chrome did not write the image: ${run.stderr}`);
console.log(`wrote public/og.png (${Math.round(statSync(out).size / 1024)} KB)`);
