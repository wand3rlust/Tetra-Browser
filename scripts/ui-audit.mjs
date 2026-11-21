#!/usr/bin/env node
/**
 * Geometry-based UI audit: loads the app with sample logs in headless Chromium
 * and reports, per viewport and tab:
 *   - element pairs that visually overlap (excluding ancestor relationships)
 *   - elements whose content is clipped (scrollWidth/scrollHeight > box)
 *   - elements wider than the viewport / document (horizontal overflow)
 *
 * Usage: node scripts/ui-audit.mjs [port]
 */
import { chromium } from 'playwright';

const port = process.argv[2] ?? '5173';
const base = `http://localhost:${port}`;

const VIEWPORTS = [
  { name: 'w1920', width: 1920, height: 1080 },
  { name: 'w1366', width: 1366, height: 768 },
  { name: 'w1024', width: 1024, height: 700 },
  { name: 'w800', width: 800, height: 600 },
];

/** Runs inside the page: finds overlap + clipping defects. */
const AUDIT_FN = () => {
  const vw = window.innerWidth;
  const issues = [];
  const selector = [
    '.et-header', '.et-row', '.et-cell', '.et-toolbar', '.event-detail',
    '.ed-head', '.ed-section', '.ed-section-head', '.ed-message', '.kv',
    '.kv-val', '.proc-binary', '.proc-args', '.raw-json', '.filter-bar',
    '.filter-controls', '.pt-row', '.pt-args', '.pt-binary', '.chart-card',
    '.chart-box', '.app-header', '.tabs', '.dashboard', '.arg-value',
  ].join(', ');
  const els = [...document.querySelectorAll(selector)];
  const rects = new Map();

  /** Effective visual rect: intersected with every clipping ancestor. */
  const effectiveRect = (el) => {
    let r = el.getBoundingClientRect();
    for (let a = el.parentElement; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const ar = a.getBoundingClientRect();
      const left = Math.max(r.left, ar.left);
      const right = Math.min(r.right, ar.right);
      const top = Math.max(r.top, ar.top);
      const bottom = Math.min(r.bottom, ar.bottom);
      if (left >= right - 1 || top >= bottom - 1) return null; // fully clipped
      r = { left, right, top, bottom };
    }
    return r;
  };

  for (const el of els) {
    const r = effectiveRect(el);
    if (!r || r.width <= 1 || r.height <= 1) continue;
    rects.set(el, r);
  }

  const overlaps = (a, b) =>
    a.left < b.right - 1 && b.left < a.right - 1 &&
    a.top < b.bottom - 1 && b.top < a.bottom - 1;

  // 1) overlapping elements (skip ancestor/descendant pairs)
  const list = [...rects.entries()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [ea, ra] = list[i];
      const [eb, rb] = list[j];
      if (ea.contains(eb) || eb.contains(ea)) continue;
      if (overlaps(ra, rb)) {
        issues.push({
          kind: 'OVERLAP',
          a: describe(ea),
          b: describe(eb),
          rect: `${Math.round(ra.left)},${Math.round(ra.top)},${Math.round(ra.right)},${Math.round(ra.bottom)} vs ${Math.round(rb.left)},${Math.round(rb.top)},${Math.round(rb.right)},${Math.round(rb.bottom)}`,
        });
      }
    }
  }

  // 2) clipped text (content wider/taller than its box while clipping styles)
  for (const [el, r] of rects) {
    const clipX = ['hidden', 'clip'].includes(getComputedStyle(el).overflowX);
    if (clipX && el.scrollWidth > el.clientWidth + 2 && r.width > 8) {
      // expected ellipsis on table cells/args is fine unless it's a container
      const isCell = el.classList.contains('et-cell');
      const isArgs = el.classList.contains('pt-args');
      if (!isCell && !isArgs) {
        issues.push({
          kind: 'CLIPPED_X',
          el: describe(el),
          detail: `scrollW ${el.scrollWidth} > clientW ${el.clientWidth}`,
        });
      }
    }
    const clipY = ['hidden', 'clip'].includes(getComputedStyle(el).overflowY);
    if (clipY && el.scrollHeight > el.clientHeight + 2 && r.height > 8) {
      // vertical scroll areas are intentional; only flag non-scroll containers
      if (getComputedStyle(el).overflowY !== 'auto' && getComputedStyle(el).overflowY !== 'scroll') {
        issues.push({ kind: 'CLIPPED_Y', el: describe(el), detail: `scrollH ${el.scrollHeight} > clientH ${el.clientHeight}` });
      }
    }
  }

  // 3) horizontal overflow beyond viewport
  if (document.documentElement.scrollWidth > vw + 1) {
    const culprits = [];
    for (const [el, r] of rects) {
      if (r.right > vw + 1) culprits.push(`${describe(el)} right=${Math.round(r.right)}`);
    }
    issues.push({ kind: 'PAGE_OVERFLOW_X', detail: `scrollW ${document.documentElement.scrollWidth} > vw ${vw}`, culprits: culprits.slice(0, 6) });
  }

  function describe(el) {
    const cls = [...el.classList].slice(0, 3).join('.');
    const txt = (el.textContent || '').trim().slice(0, 40).replace(/\s+/g, ' ');
    return `<${el.tagName.toLowerCase()} .${cls}> "${txt}"`;
  }
  return issues;
};

const browser = await chromium.launch();
try {
  const allFindings = [];
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Load sample logs' }).click();
    await page.getByRole('button', { name: /Dashboard/ }).waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);

    const states = [
      { name: 'events-first', setup: async () => {
        await page.getByRole('button', { name: /^Events/ }).click();
        await page.locator('.et-row').first().click();
      } },
      { name: 'events-longargs', setup: async () => {
        const row = page.locator('.et-row', { hasText: '(id; hostname)' }).first();
        if (await row.count()) await row.click();
      } },
      { name: 'events-rawjson', setup: async () => {
        const btn = page.getByRole('button', { name: 'show raw JSON' });
        if (await btn.count()) await btn.click();
      } },
      { name: 'tree', setup: async () => {
        await page.getByRole('button', { name: 'Process Tree' }).click();
      } },
      { name: 'dashboard', setup: async () => {
        await page.getByRole('button', { name: 'Dashboard' }).click();
      } },
    ];

    for (const state of states) {
      try {
        await state.setup();
        await page.waitForTimeout(250);
        // reset scroll positions so elements hidden under clipped scroll
        // regions aren't reported as false overlaps
        await page.evaluate(() => {
          document.querySelectorAll('.et-body, .pt-scroll, .event-detail').forEach((el) => {
            el.scrollTop = 0;
            el.scrollLeft = 0;
          });
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(100);
        const issues = await page.evaluate(AUDIT_FN);
        for (const issue of issues) {
          allFindings.push({ vp: vp.name, state: state.name, ...issue });
        }
      } catch (e) {
        allFindings.push({ vp: vp.name, state: state.name, kind: 'SETUP_ERROR', detail: e.message.slice(0, 100) });
      }
    }
    await page.close();
  }

  // summarize
  const byKey = new Map();
  for (const f of allFindings) {
    const key = `${f.kind}|${f.a ?? f.el ?? ''}|${f.b ?? ''}`;
    byKey.set(key, byKey.get(key) ?? { ...f, vps: new Set() });
    byKey.get(key).vps.add(`${f.vp}/${f.state}`);
  }
  if (byKey.size === 0) {
    console.log('NO LAYOUT DEFECTS FOUND');
  } else {
    console.log(`=== ${byKey.size} distinct layout defects ===`);
    for (const f of byKey.values()) {
      const vps = [...f.vps].join(', ');
      if (f.kind === 'OVERLAP') console.log(`[OVERLAP] ${f.a}  ✕  ${f.b}\n    at ${vps}`);
      else if (f.kind === 'PAGE_OVERFLOW_X') console.log(`[PAGE-OVERFLOW-X] ${f.detail}\n    culprits: ${f.culprits.join(' | ')}\n    at ${vps}`);
      else console.log(`[${f.kind}] ${f.el ?? ''} ${f.detail ?? ''}\n    at ${vps}`);
    }
  }
} finally {
  await browser.close();
}
