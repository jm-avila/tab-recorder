// Pure helpers shared by the extension pages and the tests.

export const MIME_TYPES = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

/** First MIME type the recorder supports, or '' to let the browser pick. */
export function pickMimeType(isSupported) {
  return MIME_TYPES.find((type) => isSupported(type)) ?? '';
}

/** "Meet – abc-defg-hij" → "meet-abc-defg-hij". Empty or symbol-only → "tab". */
export function slugify(title) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'tab';
}

const pad = (n) => String(n).padStart(2, '0');

/** Downloads-relative path, e.g. "tab-recordings/2026-11-06_143005_meet-abc.webm". */
export function recordingFilename(date, title) {
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `tab-recordings/${stamp}_${slugify(title)}.webm`;
}

/** Tape counter, always h:mm:ss style: 754_000 → "00:12:34". Negative → zero. */
export function counterDigits(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(total / 3600) % 100, Math.floor((total % 3600) / 60), total % 60].map(pad).join(':');
}

/** RMS of a [-1, 1] signal → VU, where 0 VU = -18 dBFS (broadcast alignment). Silence → -Infinity. */
export function rmsToVu(rms) {
  return rms > 0 ? 20 * Math.log10(rms) + 18 : -Infinity;
}

/** Needle angle in degrees for a VU reading: -20 VU (and below) → -48°, +3 VU (and above) → +48°. */
export function needleAngle(vu) {
  const clamped = Math.min(3, Math.max(-20, Number.isFinite(vu) ? vu : -20));
  return -48 + ((clamped + 20) / 23) * 96;
}

const REEL_EMPTY = 14;
const REEL_FULL = 40;
const REEL_HOUR = 3_600_000;

/** Tape pack radii: one hour moves the whole tape from the supply reel to the take-up reel. */
export function tapePack(ms) {
  const f = Math.min(1, Math.max(0, ms / REEL_HOUR));
  const area = REEL_FULL ** 2 - REEL_EMPTY ** 2;
  return {
    supply: Math.sqrt(REEL_FULL ** 2 - f * area),
    takeUp: Math.sqrt(REEL_EMPTY ** 2 + f * area),
  };
}
