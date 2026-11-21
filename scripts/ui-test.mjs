#!/usr/bin/env node
/**
 * UI screenshot harness: drives the app in headless Chromium with the bundled
 * sample logs and captures PNGs of every tab at several viewport widths.
 *
 * Usage:
 *   node scripts/ui-test.mjs [port]        (default 5173; dev server must run)
 *
 * Screenshots -->  screenshots/ (gitignored) for visual inspection.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const port = process.argv[2] ?? '5173';
const base = `http://localhost:${port}`;
const outDir = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const VIEWPORTS = [
  { name: 'w1920', width: 1920, height: 1080 },
  { name: 'w1366', width: 1366, height: 768 },
  { name: 'w1024', width: 1024, height: 700 },
  { name: 'w800', width: 800, height: 600 },
];

const browser = await chromium.launch();
const consoleMessages = [];

try {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        consoleMessages.push(`[${vp.name}] ${m.type()}: ${m.text()}`);
      }
    });

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Load sample logs' }).click();

    // wait for parse + store update (events tab becomes available)
    await page.getByRole('button', { name: /Dashboard/ }).waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);

    // dashboard
    await page.screenshot({ path: `${outDir}${vp.name}-dashboard.png`, fullPage: true });

    // events tab, no selection
    await page.getByRole('button', { name: /^Events/ }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}${vp.name}-events-empty-selection.png` });

    // events tab, click first row
    await page.locator('.et-row').first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}${vp.name}-events-first-event.png` });

    // events tab, click a row with long arguments (sh -c payload)
    const longArgRow = page.locator('.et-row', { hasText: '(id; hostname)' }).first();
    if (await longArgRow.count()) {
      await longArgRow.click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${outDir}${vp.name}-events-long-args.png` });
      // show raw JSON too (worst case for overflow)
      const rawBtn = page.getByRole('button', { name: 'show raw JSON' });
      if (await rawBtn.count()) {
        await rawBtn.click();
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${outDir}${vp.name}-events-raw-json.png` });
      }
    }

    // process tree
    await page.getByRole('button', { name: 'Process Tree' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}${vp.name}-tree.png`, fullPage: false });

    await page.close();
  }

  if (consoleMessages.length) {
    console.log('console errors/warnings:');
    for (const m of consoleMessages) console.log('  ' + m);
  } else {
    console.log('no console errors/warnings');
  }
  console.log(`screenshots written to ${outDir}`);
} finally {
  await browser.close();
}
