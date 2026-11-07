// Renders icons/icon.svg to the PNG sizes Chrome uses: node icons/render.js
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = dirname(fileURLToPath(import.meta.url));
const svg = await readFile(join(dir, 'icon.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.locator('svg').screenshot({ path: join(dir, `icon-${size}.png`), omitBackground: true });
  console.log(`icons/icon-${size}.png`);
}
await browser.close();
