// End to end: record a fake meeting tab in Chromium, then check the saved file with ffprobe/ffmpeg.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { evalInPopup, launchWithExtension, popupCdp, startServer, EXT_DIR } from './harness.js';

const server = await startServer();
const meetingUrl = `http://127.0.0.1:${server.address().port}/`;
const contexts = [];
after(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  server.close();
});

async function setup(opts) {
  const { context, id } = await launchWithExtension(opts);
  contexts.push(context);
  const meeting = await context.newPage();
  await meeting.goto(meetingUrl);
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${id}/popup.html`);
  // Without the "tabs" permission titles and URLs are hidden, so the meeting is the newest other tab.
  const tabId = await ext.evaluate(async () => {
    const self = await chrome.tabs.getCurrent();
    return Math.max(...(await chrome.tabs.query({})).map((t) => t.id).filter((id) => id !== self.id));
  });
  const send = (type) =>
    ext.evaluate(([type, tabId]) => chrome.runtime.sendMessage({ target: 'background', type, tabId }), [type, tabId]);
  return { context, meeting, ext, send, tabId };
}

const sessionState = (page) => page.evaluate(() => chrome.storage.session.get(null));
const badge = (page) => page.evaluate(() => chrome.action.getBadgeText({}));

async function waitForState(page, predicate, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const state = await sessionState(page);
    if (predicate(state)) return state;
    if (state.error) throw new Error(`Extension error: ${state.error}`);
    if (Date.now() > end) throw new Error(`Timed out, last state: ${JSON.stringify(state)}`);
    await page.waitForTimeout(250);
  }
}
const recording = (page) => waitForState(page, (s) => s.status === 'recording' && s.mic != null);
const saved = (page) => waitForState(page, (s) => s.status === 'idle' && s.lastFile);

// MediaRecorder WebM has no duration header, so decode it to measure length and loudness.
function inspect(file) {
  const streams = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', file]),
  ).streams.map((s) => s.codec_type);
  const { status, stderr } = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  if (status !== 0) throw new Error(`ffmpeg failed: ${stderr}`);
  const [, h, m, s] = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  const seconds = +h * 3600 + +m * 60 + +s;
  const meanDb = Number(stderr.match(/mean_volume: (-?[\d.]+) dB/)[1]);
  console.log(`  ${file}: ${streams.join('+')}, ${seconds}s, mean ${meanDb} dB`);
  return { streams: streams.sort(), seconds, meanDb };
}

test('silent tab + mic: records video and the mic, saves to tab-recordings/', async () => {
  const { ext, send } = await setup({ mic: true });
  await send('start');
  assert.equal((await recording(ext)).mic, true);
  assert.equal(await badge(ext), 'REC');

  await ext.waitForTimeout(4000);
  await send('stop');
  const done = await saved(ext);

  assert.match(done.lastFile, /\/tab-recordings\/\d{4}-\d{2}-\d{2}_\d{6}_[a-z0-9-]+\.webm$/);
  assert.ok(existsSync(done.lastFile));
  assert.equal(await badge(ext), '');
  const offscreen = await ext.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  assert.equal(offscreen.length, 0, 'offscreen document closed after saving');

  const file = inspect(done.lastFile);
  assert.deepEqual(file.streams, ['audio', 'video']);
  assert.ok(file.seconds >= 3, `duration ${file.seconds}s`);
  assert.ok(file.meanDb > -60, `mic audio present (${file.meanDb} dB)`); // the tab is silent: only the fake mic beeps
});

test('no mic grant: records tab audio only and says so', async () => {
  const { meeting, ext, send } = await setup({ mic: false });
  await meeting.click('canvas'); // 440 Hz tone in the tab
  await send('start');
  assert.equal((await recording(ext)).mic, false);

  await ext.waitForTimeout(3000);
  await send('stop');
  const file = inspect((await saved(ext)).lastFile);
  assert.deepEqual(file.streams, ['audio', 'video']);
  assert.ok(file.meanDb > -40, `tab audio present (${file.meanDb} dB)`);
});

test('a second start is ignored; closing the tab saves the recording', async () => {
  const { meeting, ext, send } = await setup({ mic: true });
  await send('start');
  const first = await recording(ext);
  await send('start');
  await ext.waitForTimeout(2000);
  assert.equal((await sessionState(ext)).startedAt, first.startedAt, 'still the first recording');

  await meeting.close();
  const done = await saved(ext);
  assert.ok(existsSync(done.lastFile));
  assert.ok(inspect(done.lastFile).seconds >= 1);
});

test('stop when idle is a no-op', async () => {
  const { ext, send } = await setup({ mic: true });
  await send('stop');
  await ext.waitForTimeout(500);
  const state = await sessionState(ext);
  assert.ok(state.status === undefined || state.status === 'idle');
  assert.equal(await badge(ext), '');
});

test('popup records the tab it was opened on, not another one', async () => {
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const { context, meeting, ext, tabId } = await setup({ mic: true, debugPort });
  const other = await context.newPage(); // a newer tab that must not be recorded
  await other.goto(meetingUrl);
  await meeting.bringToFront();
  await context.serviceWorkers()[0].evaluate(() => chrome.action.openPopup());
  await ext.waitForTimeout(500);
  await evalInPopup(debugPort, "document.getElementById('rec').click()");
  const state = await recording(ext);
  assert.equal(state.tabId, tabId, 'recording the tab the popup was opened on');

  // The mic meter's needle leaves the rest position (-48°) on the fake mic's beeps.
  await ext.waitForTimeout(1500);
  const angle = await evalInPopup(debugPort, `(async () => {
    let max = -90;
    for (let i = 0; i < 30; i++) {
      const m = document.querySelector('#meter-mic line[stroke="#1a1c1b"]').style.transform.match(/-?[\\d.]+/);
      max = Math.max(max, Number(m?.[0] ?? -90));
      await new Promise((r) => setTimeout(r, 50));
    }
    return max;
  })()`);
  assert.ok(angle > -40, `mic needle moved (max ${angle}°)`);
  const { data } = await popupCdp(debugPort, 'Page.captureScreenshot', { format: 'png' });
  await writeFile(`${EXT_DIR}/test/screenshots/live-recording.png`, Buffer.from(data, 'base64'));
  await meeting.close();
  await saved(ext);
});

test('mic.html grants the mic, then starts on the tab it was opened for', async () => {
  const { context, ext, tabId } = await setup({ mic: false }); // first run: permission still "prompt"
  const mic = await context.newPage();
  const closed = mic.waitForEvent('close');
  await mic.goto(ext.url().replace('popup.html', `mic.html?tabId=${tabId}`));
  const state = await recording(ext);
  assert.equal(state.tabId, tabId);
  // state.mic stays false here: the auto-accept flag grants once and doesn't persist like a real "Allow".
  await closed; // mic.html closes itself
  await ext.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'stop' }));
  await saved(ext);
});

test('refuses to record an extension page', async () => {
  const { ext } = await setup({ mic: true });
  const self = await ext.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  await ext.evaluate((tabId) => chrome.runtime.sendMessage({ target: 'background', type: 'start', tabId }), self);
  await assert.rejects(recording(ext), /Open the meeting tab/);
});
