// Service worker: owns state, tab capture and downloads. Recording happens in offscreen.html.
import { recordingFilename } from './lib.js';

const OFFSCREEN_URL = 'offscreen.html';
const IDLE = { status: 'idle', startedAt: null, tabId: null, tabTitle: null, mic: null, error: null };

const getState = async () => ({ ...IDLE, ...(await chrome.storage.session.get(null)) });
const setState = (patch) => chrome.storage.session.set(patch);

async function setBadge(status) {
  const text = { recording: 'REC', saving: '…' }[status] ?? '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Record tab video, tab audio and microphone.',
  });
}

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) await chrome.offscreen.closeDocument();
}

async function start(tabId) {
  if ((await getState()).status !== 'idle') return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('Open the meeting tab and press Start there.');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    await setState({
      status: 'recording',
      startedAt: Date.now(),
      tabId,
      tabTitle: tab.title ?? '',
      mic: null,
      error: null,
      lastFile: null,
    });
    await setBadge('recording');
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start',
      streamId,
      filename: recordingFilename(new Date(), tab.title),
    });
  } catch (err) {
    await fail(err);
  }
}

async function stop() {
  if ((await getState()).status !== 'recording') return;
  await setState({ status: 'saving' });
  await setBadge('saving');
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
}

async function save(url, filename) {
  try {
    const downloadId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
    await setState({ downloadId });
  } catch (err) {
    await fail(err);
  }
}

async function fail(err) {
  await closeOffscreen();
  await setState({ ...IDLE, error: String(err?.message ?? err) });
  await setBadge('idle');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'start') start(msg.tabId);
  if (msg.type === 'stop') stop();
  if (msg.type === 'started') setState({ mic: msg.mic });
  // Capture ended on its own (tab closed or navigated away): save what we have.
  if (msg.type === 'ended') setState({ status: 'saving' }).then(() => setBadge('saving'));
  if (msg.type === 'save') save(msg.url, msg.filename);
  if (msg.type === 'error') fail(msg.message);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-recording') return;
  const { status } = await getState();
  if (status === 'idle' && tab?.id) start(tab.id);
  if (status === 'recording') stop();
});

// The blob URL lives in the offscreen document, so close it only once the file is on disk.
chrome.downloads.onChanged.addListener(async (delta) => {
  const state = await getState();
  if (delta.id !== state.downloadId) return;
  const done = delta.state?.current;
  if (done !== 'complete' && done !== 'interrupted') return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  await closeOffscreen();
  await setState({
    ...IDLE,
    downloadId: null,
    lastFile: done === 'complete' ? item?.filename ?? null : null,
    error: done === 'interrupted' ? `Download failed: ${item?.error ?? 'unknown'}` : null,
  });
  await setBadge('idle');
});
