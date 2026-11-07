// Screenshots of the popup in each state, light and dark: test/screenshots/<scheme>-<state>.png
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EXT_DIR, launchWithExtension } from './harness.js';

const OUT = join(EXT_DIR, 'test', 'screenshots');
const STATES = {
  idle: { status: 'idle' },
  recording: { status: 'recording', startedAt: Date.now() - 754_000, mic: true },
  'recording-no-mic': { status: 'recording', startedAt: Date.now() - 3_725_000, mic: false },
  'recording-other-tab': { status: 'recording', startedAt: Date.now() - 95_000, mic: true, tabId: -1, tabTitle: 'Meet – abc-defg-hij' },
  saving: { status: 'saving', startedAt: Date.now() - 60_000 },
  saved: { status: 'idle', lastFile: '/Users/me/Downloads/tab-recordings/2026-11-06_143005_meet-abc-defg-hij.webm' },
  error: { status: 'idle', error: 'Extension has not been invoked for the current page (see activeTab permission).' },
};

await mkdir(OUT, { recursive: true });
const { context, id } = await launchWithExtension();
const page = await context.newPage();
await page.setViewportSize({ width: 280, height: 420 });
await page.goto(`chrome-extension://${id}/popup.html`);

for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme });
  for (const [name, state] of Object.entries(STATES)) {
    await page.evaluate(async (s) => {
      await chrome.storage.session.clear();
      // Recording states belong to the tab the popup is open on, unless the state says otherwise.
      await chrome.storage.session.set({ tabId: (await chrome.tabs.getCurrent()).id, ...s });
    }, state);
    await page.waitForTimeout(150);
    const path = join(OUT, `${scheme}-${name}.png`);
    await page.locator('body').screenshot({ path, animations: 'disabled' });
    console.log(path);
  }
}
await context.close();
