// Shared Playwright setup: a fake "meeting" page and Chromium with the extension loaded.
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// Moving canvas + a quiet 440 Hz tone once clicked: gives the recorder real video and tab audio.
const MEETING_PAGE = `<!doctype html><title>Meet – test-call</title>
<canvas id="c" width="640" height="360"></canvas>
<script>
  const ctx = document.getElementById('c').getContext('2d');
  (function draw(t) {
    ctx.fillStyle = '#123'; ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#fc0'; ctx.fillRect((t / 5) % 640, 150, 60, 60);
    requestAnimationFrame(draw);
  })(0);
  document.addEventListener('click', () => {
    const a = new AudioContext(); const o = a.createOscillator();
    const g = a.createGain(); g.gain.value = 0.05; // quiet: the recorder plays the tab back
    o.frequency.value = 440; o.connect(g).connect(a.destination); o.start();
  }, { once: true });
</script>`;

export function startServer() {
  const server = createServer((_, res) => res.end(MEETING_PAGE));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function launch(userDir, args, downloadsPath) {
  return chromium.launchPersistentContext(userDir, {
    headless: !process.env.HEADED,
    channel: 'chromium', // full Chromium; the default headless shell can't load extensions
    ignoreDefaultArgs: ['--mute-audio'], // a muted tab captures as silence
    acceptDownloads: true,
    downloadsPath,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, ...args],
  });
}

async function extensionId(context) {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return new URL(sw.url()).host;
}

// Downloads go to a temp dir. The mic grant is what clicking "Allow" in mic.html stores. Playwright can't grant permissions to extension
// origins, and --use-fake-ui-for-media-stream breaks tab capture ("Requested device not found").
async function seedPrefs(userDir, id, { mic, downloadsPath }) {
  const file = join(userDir, 'Default', 'Preferences');
  const prefs = JSON.parse(await readFile(file, 'utf8'));
  prefs.profile ??= {};
  prefs.profile.content_settings ??= {};
  prefs.profile.content_settings.exceptions ??= {};
  if (mic) {
    prefs.profile.content_settings.exceptions.media_stream_mic = {
      [`chrome-extension://${id}/,*`]: { setting: 1 },
    };
  }
  prefs.download = { default_directory: downloadsPath, prompt_for_download: false };
  await writeFile(file, JSON.stringify(prefs));
}

/**
 * Chromium with the extension, a fake (beeping) mic, and tab capture allowed without a
 * toolbar click (--allowlisted-extension-id), since tests can't press the extension button.
 */
export async function launchWithExtension({ mic = true, debugPort } = {}) {
  const userDir = await mkdtemp(join(tmpdir(), 'tab-recorder-profile-'));
  const downloadsPath = await mkdtemp(join(tmpdir(), 'tab-recorder-dl-'));
  const probe = await launch(userDir, [], downloadsPath);
  const id = await extensionId(probe);
  await probe.close();
  await seedPrefs(userDir, id, { mic, downloadsPath });
  const context = await launch(
    userDir,
    [
      '--use-fake-device-for-media-stream',
      '--auto-accept-camera-and-microphone-capture',
      '--autoplay-policy=no-user-gesture-required',
      `--allowlisted-extension-id=${id}`,
      // Playwright doesn't expose the toolbar popup; tests reach it over raw CDP on this port.
      ...(debugPort ? [`--remote-debugging-port=${debugPort}`] : []),
    ],
    downloadsPath,
  );
  await extensionId(context);
  // Playwright's download handling renames files to GUIDs; hand downloads back to Chrome.
  const cdp = await context.newCDPSession(context.pages()[0] ?? (await context.newPage()));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  return { context, id, downloadsPath };
}

/** Send one CDP command to the open toolbar popup (needs launchWithExtension({ debugPort })). */
export async function popupCdp(debugPort, method, params = {}) {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const popup = targets.find((t) => t.url.endsWith('/popup.html'));
  if (!popup) throw new Error('popup not open');
  const ws = new WebSocket(popup.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const reply = new Promise((resolve) => ws.addEventListener('message', (e) => resolve(JSON.parse(e.data))));
  ws.send(JSON.stringify({ id: 1, method, params }));
  const { result, error } = await reply;
  ws.close();
  if (error) throw new Error(`${method}: ${error.message}`);
  return result;
}

export const evalInPopup = async (debugPort, expression) =>
  (await popupCdp(debugPort, 'Runtime.evaluate', { expression, awaitPromise: true })).result.value;
