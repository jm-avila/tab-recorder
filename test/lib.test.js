import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterDigits, needleAngle, pickMimeType, recordingFilename, rmsToVu, slugify, tapePack, MIME_TYPES } from '../lib.js';

test('slugify: Meet title', () => {
  assert.equal(slugify('Meet – abc-defg-hij'), 'meet-abc-defg-hij');
});

test('slugify: strips accents and symbols', () => {
  assert.equal(slugify('Reunión: Diseño & Planificación!'), 'reunion-diseno-planificacion');
});

test('slugify: empty, missing or symbol-only falls back to "tab"', () => {
  assert.equal(slugify(''), 'tab');
  assert.equal(slugify(undefined), 'tab');
  assert.equal(slugify('🎥 — 🎥'), 'tab');
});

test('slugify: caps length without a trailing dash', () => {
  const slug = slugify(`${'a'.repeat(59)} bbbb`);
  assert.ok(slug.length <= 60);
  assert.ok(!slug.endsWith('-'));
});

test('recordingFilename: dated path in tab-recordings/', () => {
  const date = new Date(2026, 10, 6, 9, 5, 7);
  assert.equal(recordingFilename(date, 'Meet – abc'), 'tab-recordings/2026-11-06_090507_meet-abc.webm');
});

test('counterDigits: fixed h:mm:ss', () => {
  assert.equal(counterDigits(0), '00:00:00');
  assert.equal(counterDigits(754_000), '00:12:34');
  assert.equal(counterDigits(3_725_000), '01:02:05');
  assert.equal(counterDigits(-5), '00:00:00');
});

test('rmsToVu: 0 VU at -18 dBFS, silence is -Infinity', () => {
  assert.ok(Math.abs(rmsToVu(10 ** (-18 / 20))) < 1e-9);
  assert.ok(Math.abs(rmsToVu(1) - 18) < 1e-9);
  assert.equal(rmsToVu(0), -Infinity);
});

test('needleAngle: scale ends, clamping, silence', () => {
  assert.equal(needleAngle(-20), -48);
  assert.equal(needleAngle(3), 48);
  assert.equal(needleAngle(99), 48);
  assert.equal(needleAngle(-Infinity), -48);
  assert.equal(needleAngle(NaN), -48);
  assert.ok(needleAngle(0) > 0 && needleAngle(0) < 48);
});

test('tapePack: full supply at start, swapped after an hour, tape area conserved', () => {
  assert.deepEqual(tapePack(0), { supply: 40, takeUp: 14 });
  const end = tapePack(3_600_000);
  assert.ok(Math.abs(end.supply - 14) < 1e-9 && Math.abs(end.takeUp - 40) < 1e-9);
  assert.deepEqual(tapePack(9_000_000), tapePack(3_600_000));
  const mid = tapePack(1_800_000);
  assert.ok(Math.abs(mid.supply ** 2 + mid.takeUp ** 2 - (40 ** 2 + 14 ** 2)) < 1e-9);
});

test('pickMimeType: first supported, else empty', () => {
  assert.equal(pickMimeType(() => true), MIME_TYPES[0]);
  assert.equal(pickMimeType((t) => t === 'video/webm'), 'video/webm');
  assert.equal(pickMimeType(() => false), '');
});
