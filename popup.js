import { counterDigits, needleAngle, tapePack } from './lib.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg });
// The tab the icon was clicked on. Read once: opening mic.html changes the active tab.
const [clickedTab] = await chrome.tabs.query({ active: true, currentWindow: true });

let state = { status: 'idle' };
let ticker = null;

// --- Meters -----------------------------------------------------------------

const PIVOT = { x: 60, y: 60 };
const svg = (tag, attrs, parent) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return parent.appendChild(el);
};
const polar = (deg, r) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [PIVOT.x + r * Math.cos(a), PIVOT.y + r * Math.sin(a)];
};

function buildMeter(el, label) {
  svg('rect', { width: 120, height: 64, fill: '#eef0e4' }, el);
  const [rx1, ry1] = polar(needleAngle(0), 46);
  const [rx2, ry2] = polar(needleAngle(3), 46);
  svg('path', { d: `M${rx1} ${ry1}A46 46 0 0 1 ${rx2} ${ry2}`, fill: 'none', stroke: '#d7362b', 'stroke-width': 4 }, el);
  for (const vu of [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3]) {
    const major = [-20, -10, -5, 0, 3].includes(vu);
    const [x1, y1] = polar(needleAngle(vu), major ? 40 : 43);
    const [x2, y2] = polar(needleAngle(vu), 49);
    const color = vu > 0 ? '#d7362b' : '#2d302e';
    svg('line', { x1, y1, x2, y2, stroke: color, 'stroke-width': major ? 1.4 : 0.9 }, el);
    if (major) {
      const [tx, ty] = polar(needleAngle(vu), 33);
      svg('text', { x: tx, y: ty + 3, 'text-anchor': 'middle', 'font-size': 8, fill: color }, el).textContent = Math.abs(vu);
    }
  }
  svg('text', { x: 6, y: 13, 'font-size': 11, fill: '#2d302e' }, el).textContent = label;
  const needle = svg('line', { x1: PIVOT.x, y1: PIVOT.y, x2: PIVOT.x, y2: 10, stroke: '#1a1c1b', 'stroke-width': 1.3 }, el);
  needle.style.transformOrigin = `${PIVOT.x}px ${PIVOT.y}px`;
  svg('rect', { x: 0, y: 60, width: 120, height: 4, fill: '#232624' }, el);
  svg('circle', { cx: PIVOT.x, cy: PIVOT.y, r: 4, fill: '#232624' }, el);
  const rest = needleAngle(-Infinity);
  return { needle, angle: rest, target: rest };
}

const meters = { tab: buildMeter($('meter-tab'), 'Meeting'), mic: buildMeter($('meter-mic'), 'Mic') };

// Levels come from the offscreen recorder; when nothing records, needles rest on the stop pin.
async function pollLevels() {
  const levels =
    state.status === 'recording'
      ? await chrome.runtime.sendMessage({ target: 'offscreen', type: 'levels' }).catch(() => null)
      : null;
  for (const [key, meter] of Object.entries(meters)) meter.target = needleAngle(levels?.[key] ?? -Infinity);
}

function animateNeedles() {
  for (const meter of Object.values(meters)) {
    meter.angle += (meter.target - meter.angle) * 0.35; // VU-style ballistics
    meter.needle.style.transform = `rotate(${meter.angle}deg)`;
  }
  requestAnimationFrame(animateNeedles);
}

// --- Reels and counter ----------------------------------------------------------

function drawTape(elapsedMs) {
  const { supply, takeUp } = tapePack(elapsedMs);
  $('pack-supply').setAttribute('r', supply);
  $('pack-take-up').setAttribute('r', takeUp);
  $('tape').setAttribute('d', `M${66 - supply * 0.7} ${52 + supply * 0.7}L126 104H154L${214 + takeUp * 0.7} ${52 + takeUp * 0.7}`);
}

function drawCounter(elapsedMs) {
  $('counter').replaceChildren(
    ...[...counterDigits(elapsedMs)].map((ch) => {
      const span = document.createElement('span');
      span.textContent = ch;
      if (ch === ':') span.className = 'sep';
      return span;
    }),
  );
}

function tick() {
  const elapsed = state.status === 'recording' ? Date.now() - state.startedAt : 0;
  drawCounter(elapsed);
  drawTape(elapsed);
}

// --- State ----------------------------------------------------------------------

function render() {
  const { status } = state;
  document.body.className = status;
  $('label').textContent = { idle: 'Ready', recording: 'Recording', saving: 'Saving…' }[status];
  $('rec').classList.toggle('down', status === 'recording');
  $('rec').disabled = status !== 'idle';
  $('stop').disabled = status !== 'recording';

  clearInterval(ticker);
  tick();
  if (status === 'recording') ticker = setInterval(tick, 500);

  let note = '';
  if (state.error) note = state.error;
  else if (status === 'recording' && state.tabId !== clickedTab?.id) note = `Recording another tab: ${state.tabTitle || 'untitled'}`;
  else if (status === 'recording' && state.mic === false) note = 'Mic unavailable: recording the meeting audio only.';
  else if (status === 'idle') note = state.lastFile ? `Saved to ${state.lastFile.split('/').slice(-2).join('/')}` : 'Press Record, or Alt+Shift+R.';
  $('note').textContent = note;
  $('note').classList.toggle('error', Boolean(state.error));
}

async function refresh() {
  state = { status: 'idle', ...(await chrome.storage.session.get(null)) };
  render();
}

$('rec').addEventListener('click', async () => {
  // The popup can't show a permission prompt: mic.html asks once, then starts on the clicked tab.
  const { state: mic } = await navigator.permissions.query({ name: 'microphone' });
  if (mic === 'prompt') return chrome.tabs.create({ url: `mic.html?tabId=${clickedTab.id}` });
  toBackground({ type: 'start', tabId: clickedTab.id });
});
$('stop').addEventListener('click', () => toBackground({ type: 'stop' }));

chrome.storage.session.onChanged.addListener(refresh);
await refresh();
setInterval(pollLevels, 60);
animateNeedles();
