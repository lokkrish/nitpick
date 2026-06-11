#!/usr/bin/env node
/**
 * Nitpick sanity check — drives a real browser against your running dev server and verifies the
 * overlay end-to-end. Run by /nitpick:sanity after setup; safe to run any time.
 *
 *   node sanity.mjs [--url=http://localhost:3000] [--color-scheme=light|dark] [--headed]
 *
 * Run from your project root (Playwright is resolved from the project's node_modules; install
 * with `npm i -D playwright && npx playwright install chromium` if missing).
 *
 * What it verifies:
 *   1. The overlay mounts (idle badge present) and activates.
 *   2. The Snip capture layer covers the FULL viewport, and selection works in all four corners
 *      (marquee drags at TL / TR / BL / BR) — not just a strip at the top.
 *   3. The full snip pipeline: drag → region captured → editor opens → the captured pixels
 *      actually MATCH the page region (compared against a native screenshot — catches blank,
 *      black, and shifted captures) → drawing works → Esc. Run with --color-scheme=dark too:
 *      capture bugs can be scheme-dependent.
 *   4. The same geometry + corner checks under a hostile host reset
 *      (`img, svg, video { max-width: 100%; height: auto }`) — the regression that shipped
 *      broken overlays before v0.4.0 sized everything with inline CSS.
 *   5. Esc deactivates the overlay cleanly (badge returns).
 *   6. The "Fix me" flow saves a report about the tool itself (captureType "meta").
 *   7. The /api/nitpick bridge accepts a probe report and queues it. (Both probes are deleted
 *      from `.nitpick/` afterwards — this script leaves no feedback behind.)
 *
 * Report-only: it never modifies your app. Exit code 0 = all pass (warnings allowed), 1 = at
 * least one failure, 2 = couldn't run (no browser / no dev server).
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => (args.find((a) => a.startsWith(`--${name}=`)) || `=${dflt}`).split('=').slice(1).join('=');
const BASE = opt('url', 'http://localhost:3000').replace(/\/$/, '');
const HEADED = flag('headed');
const SCHEME = opt('color-scheme', 'light'); // run twice — light AND dark — to catch scheme-dependent capture bugs
const VW = 1280; const VH = 800;

const results = [];
const pass = (name, detail = '') => { results.push({ s: 'PASS', name, detail }); log('PASS', name, detail); };
const fail = (name, detail = '') => { results.push({ s: 'FAIL', name, detail }); log('FAIL', name, detail); };
const warn = (name, detail = '') => { results.push({ s: 'WARN', name, detail }); log('WARN', name, detail); };
const log = (s, name, detail) => console.log(`${s === 'PASS' ? '✓' : s === 'WARN' ? '⚠' : '✗'} [${s}] ${name}${detail ? ` — ${detail}` : ''}`);

// Resolve Playwright from the PROJECT (cwd), not from wherever this script lives in the plugin.
async function resolveChromium() {
  const candidates = ['playwright', 'playwright-core', '@playwright/test'];
  try {
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    for (const pkg of candidates) {
      try {
        const mod = await import(req.resolve(pkg));
        const chromium = (mod.chromium ?? mod.default?.chromium);
        if (chromium) return chromium;
      } catch { /* try next */ }
    }
  } catch { /* no package.json in cwd — fall through */ }
  for (const pkg of candidates) {
    try { const mod = await import(pkg); const c = mod.chromium ?? mod.default?.chromium; if (c) return c; } catch { /* try next */ }
  }
  return null;
}

const ROOT_SEL = 'div[data-nitpick-ui="root"]';
const LAYER_SEL = `${ROOT_SEL} svg[data-nitpick-ui]`;     // viewport capture/highlight layer
const MARQUEE_SEL = `${LAYER_SEL} rect[stroke-dasharray]`; // in-progress snip selection
const BADGE_SEL = 'button[data-nitpick-ui][title*="Activate Nitpick"]';
const EDITOR_IMG_SEL = 'img[alt="snip"]';
const EDITOR_SVG_SEL = `${ROOT_SEL} svg[viewBox]`;         // snip-editor drawing layer

async function main() {
  const chromium = await resolveChromium();
  if (!chromium) {
    console.error('✗ Playwright not found. From your project root run:\n    npm i -D playwright && npx playwright install chromium\nthen re-run this script.');
    process.exit(2);
  }
  try { await fetch(BASE, { signal: AbortSignal.timeout(5000) }); } catch {
    console.error(`✗ Dev server not reachable at ${BASE}. Start it (npm run dev) or pass --url=…`);
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: !HEADED });
  try {
    const page = await browser.newPage({ viewport: { width: VW, height: VH }, colorScheme: SCHEME === 'dark' ? 'dark' : 'light' });
    page.setDefaultTimeout(10000);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    // ---- 1. mount + activate -----------------------------------------------------------------
    try { await page.waitForSelector(BADGE_SEL); pass('overlay mounts', 'idle badge rendered'); }
    catch { fail('overlay mounts', `no Nitpick badge at ${BASE} — is NitpickOverlay mounted in the root layout and NODE_ENV=development?`); return; }

    await page.click(BADGE_SEL);
    const snipBtn = page.locator(`${ROOT_SEL} button`, { hasText: 'Snip' }).first();
    try { await snipBtn.waitFor(); pass('overlay activates', 'toolbox opened from badge'); }
    catch { fail('overlay activates', 'toolbox did not appear after clicking the badge'); return; }

    await snipBtn.click();
    try {
      await page.waitForFunction((sel) => {
        const svg = document.querySelector(sel);
        return svg && getComputedStyle(svg).pointerEvents === 'auto';
      }, LAYER_SEL);
      pass('snip arms', 'capture layer accepting pointer events');
    } catch { fail('snip arms', 'capture layer never became interactive'); return; }

    // ---- 2. full-viewport geometry + four-corner selection -----------------------------------
    const checkCoverage = async (label) => {
      const geo = await page.evaluate((sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), iw: innerWidth, ih: innerHeight };
      }, LAYER_SEL);
      if (geo.w >= geo.iw - 1 && geo.h >= geo.ih - 1) pass(`capture layer covers viewport ${label}`, `${geo.w}×${geo.h} vs ${geo.iw}×${geo.ih}`);
      else fail(`capture layer covers viewport ${label}`, `layer is ${geo.w}×${geo.h}, viewport is ${geo.iw}×${geo.ih} — a host CSS reset is collapsing the overlay svg`);

      const corners = await page.evaluate((sel) => {
        const pts = { 'top-left': [2, 2], 'top-right': [innerWidth - 3, 2], 'bottom-left': [2, innerHeight - 3], 'bottom-right': [innerWidth - 3, innerHeight - 3] };
        const bad = [];
        for (const [name, [x, y]] of Object.entries(pts)) {
          const el = document.elementFromPoint(x, y);
          if (!el || !el.closest(sel)) bad.push(`${name} hits <${el ? el.tagName.toLowerCase() : 'nothing'}>`);
        }
        return bad;
      }, LAYER_SEL);
      if (!corners.length) pass(`all four corners selectable ${label}`);
      else fail(`all four corners selectable ${label}`, corners.join('; '));
    };
    await checkCoverage('(vanilla)');

    // Marquee drag at each corner. We pull the marquee back to <6px before releasing so no
    // screenshot is captured — the full capture pipeline is exercised once, separately below.
    const dragMarquee = async (label, x, y, dx, dy) => {
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 4 });
      let ok = false;
      try {
        await page.waitForFunction((sel) => {
          const r = document.querySelector(sel);
          return r && Number(r.getAttribute('width')) > 50;
        }, MARQUEE_SEL, { timeout: 3000 });
        ok = true;
      } catch { /* reported below */ }
      await page.mouse.move(x + Math.sign(dx) * 2, y + Math.sign(dy) * 2, { steps: 2 });
      await page.mouse.up();
      if (ok) pass(`marquee drag at ${label}`);
      else fail(`marquee drag at ${label}`, 'no selection rectangle appeared — pointer events are not reaching the capture layer there');
      return ok;
    };
    await dragMarquee('top-left', 4, 4, 120, 120);
    await dragMarquee('top-right', VW - 5, 4, -120, 120);
    await dragMarquee('bottom-left', 4, VH - 5, 120, -120);
    await dragMarquee('bottom-right', VW - 5, VH - 5, -120, -120);

    // ---- 3. full snip pipeline: capture → editor → pixels match → draw → Esc -----------------
    const runSnipPipeline = async (label) => {
      // ground truth for the pixel check: what this region actually looks like, natively
      const nativeB64 = (await page.screenshot({ clip: { x: 140, y: 240, width: 280, height: 220 } })).toString('base64');
      await page.mouse.move(140, 240); await page.mouse.down();
      await page.mouse.move(420, 460, { steps: 5 }); await page.mouse.up();
      const outcome = await page.waitForFunction((sel) => {
        if (document.querySelector(sel)) return 'editor';
        const failed = [...document.querySelectorAll('[data-nitpick-ui]')].some((el) => (el.textContent || '').includes('Snip failed'));
        return failed ? 'failed' : false;
      }, EDITOR_IMG_SEL, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => 'timeout');
      if (outcome === 'failed') { warn(`snip capture ${label}`, 'html-to-image unavailable — screenshots degrade gracefully but install it (npm i -D html-to-image) for full reports'); return false; }
      if (outcome !== 'editor') { fail(`snip capture ${label}`, 'editor never opened after a region drag'); return false; }
      pass(`snip capture ${label}`, 'region captured, editor opened');

      // Pixel fidelity: the captured snip must actually LOOK like the page region. Both images
      // are downsampled to a coarse grid and compared channel-wise; a blank, black, or shifted
      // capture produces a large mean difference even though the editor "opened fine".
      const meanDiff = await page.evaluate(async ({ imgSel, nativeB64 }) => {
        const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
        const snip = await load(document.querySelector(imgSel).src);
        const native = await load('data:image/png;base64,' + nativeB64);
        const W = 28; const H = 22;
        const grid = (img) => {
          const c = document.createElement('canvas'); c.width = W; c.height = H;
          const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, W, H);
          return ctx.getImageData(0, 0, W, H).data;
        };
        const a = grid(snip); const b = grid(native);
        let sum = 0;
        for (let i = 0; i < a.length; i += 4) sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
        return Math.round(sum / (W * H));
      }, { imgSel: EDITOR_IMG_SEL, nativeB64 }).catch(() => -1);
      if (meanDiff >= 0 && meanDiff <= 32) pass(`snip pixels match the page ${label}`, `mean channel diff ${meanDiff}/255`);
      else if (meanDiff < 0) warn(`snip pixels match the page ${label}`, 'could not compare images');
      else fail(`snip pixels match the page ${label}`, `mean channel diff ${meanDiff}/255 vs a native screenshot — the capture is blank, black, or shifted`);

      const editorGeo = await page.evaluate(({ imgSel, svgSel }) => {
        const img = document.querySelector(imgSel).getBoundingClientRect();
        const svg = document.querySelector(svgSel).getBoundingClientRect();
        return { ok: Math.abs(img.width - svg.width) <= 2 && Math.abs(img.height - svg.height) <= 2, img: `${Math.round(img.width)}×${Math.round(img.height)}`, svg: `${Math.round(svg.width)}×${Math.round(svg.height)}` };
      }, { imgSel: EDITOR_IMG_SEL, svgSel: EDITOR_SVG_SEL });
      if (editorGeo.ok) pass(`editor drawing layer matches image ${label}`, editorGeo.img);
      else fail(`editor drawing layer matches image ${label}`, `image ${editorGeo.img} but drawing svg ${editorGeo.svg} — host CSS is resizing the editor svg`);

      const box = await page.locator(EDITOR_SVG_SEL).boundingBox();
      await page.mouse.move(box.x + 15, box.y + 15); await page.mouse.down();
      await page.mouse.move(box.x + 90, box.y + 70, { steps: 4 }); await page.mouse.up();
      const drew = await page.waitForFunction((sel) => !!document.querySelector(`${sel} line[marker-end]`), EDITOR_SVG_SEL, { timeout: 3000 }).then(() => true).catch(() => false);
      if (drew) pass(`drawing in editor ${label}`, 'arrow rendered');
      else fail(`drawing in editor ${label}`, 'no arrow appeared after drawing on the snip');

      await page.keyboard.press('Escape');
      const closed = await page.waitForFunction((sel) => !document.querySelector(sel), EDITOR_IMG_SEL, { timeout: 3000 }).then(() => true).catch(() => false);
      if (closed) pass(`Esc closes editor ${label}`);
      else fail(`Esc closes editor ${label}`, 'snip editor still open after Escape');
      return true;
    };
    const captureWorks = await runSnipPipeline('(vanilla)');

    // ---- 4. regression: hostile host CSS reset ------------------------------------------------
    // The exact reset that collapsed the overlay to 150px before v0.4.0. The overlay must be
    // immune to arbitrary host stylesheets — only inline styles survive every cascade.
    await page.evaluate(() => {
      const s = document.createElement('style');
      s.id = '__nitpick_sanity_hostile__';
      s.textContent = 'img, svg, video { max-width: 100%; height: auto; }';
      document.head.appendChild(s);
    });
    await checkCoverage('(hostile reset)');
    await dragMarquee('bottom-right (hostile reset)', VW - 5, VH - 5, -120, -120);
    if (captureWorks) await runSnipPipeline('(hostile reset)');
    await page.evaluate(() => document.getElementById('__nitpick_sanity_hostile__')?.remove());

    // ---- 5. Esc deactivates ------------------------------------------------------------------
    await page.keyboard.press('Escape');
    const idle = await page.waitForSelector(BADGE_SEL, { timeout: 3000 }).then(() => true).catch(() => false);
    if (idle) pass('Esc deactivates overlay', 'idle badge returned');
    else fail('Esc deactivates overlay', 'badge did not return after Escape');

    // ---- 6. "Fix me" (meta) round-trip --------------------------------------------------------
    // Reactivate, report a problem about Nitpick itself, Save — must queue as captureType "meta".
    await page.click(BADGE_SEL);
    const fixMeBtn = page.locator(`${ROOT_SEL} button`, { hasText: 'Fix me' }).first();
    const hasFixMe = await fixMeBtn.waitFor({ timeout: 3000 }).then(() => true).catch(() => false);
    if (!hasFixMe) {
      warn('Fix me reports a tool problem', 'no Fix me button — installed overlay predates v0.4.0; re-run /nitpick:setup to get it');
      await page.keyboard.press('Escape');
    } else {
      await fixMeBtn.click();
      await page.fill(`${ROOT_SEL} textarea`, '[nitpick-sanity] fix-me probe — safe to delete');
      await page.locator(`${ROOT_SEL} button`, { hasText: 'Save' }).first().click();
      const toast = await page.waitForFunction(() => {
        const el = [...document.querySelectorAll('[data-nitpick-ui]')].find((n) => (n.textContent || '').includes('Saved feedback'));
        return el ? el.textContent : false;
      }, undefined, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => null);
      const metaId = toast && (toast.match(/#(\d+)/) || [])[1];
      if (!metaId) fail('Fix me reports a tool problem', `save toast never appeared (got: ${toast})`);
      else {
        let rec = null;
        try { rec = JSON.parse(await fs.readFile(path.join(process.cwd(), '.nitpick', `${metaId}.json`), 'utf8')); } catch { /* checked below */ }
        if (rec && rec.captureType === 'meta') pass('Fix me reports a tool problem', `queued #${metaId} as captureType "meta" (tool v${rec.meta?.version ?? '?'})`);
        else if (rec) fail('Fix me reports a tool problem', `#${metaId} saved with captureType "${rec.captureType}" instead of "meta"`);
        else warn('Fix me reports a tool problem', `saved as #${metaId} but couldn't read .nitpick/${metaId}.json to verify — run from the project root`);
        await cleanupProbe(metaId);
      }
    }

    // ---- 7. API bridge -----------------------------------------------------------------------
    const probe = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/nitpick', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            comment: '[nitpick-sanity] probe — safe to delete', route: '/__nitpick_sanity__',
            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1, scrollX: 0, scrollY: 0 },
            captureType: 'full', coordSpace: 'page', annotations: [], targets: [], targetImages: [], element: null, actions: [], screenshot: null, referenceImage: null,
          }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      } catch (e) { return { status: 0, body: String(e) }; }
    });
    if (probe.status === 200 && probe.body && probe.body.ok && probe.body.id) {
      pass('API bridge saves a report', `queued as #${probe.body.id}`);
      await cleanupProbe(probe.body.id);
    } else {
      fail('API bridge saves a report', `POST /api/nitpick → ${probe.status} ${JSON.stringify(probe.body)} — is the route at app/api/nitpick/route.ts (no underscore prefix)?`);
    }
  } finally {
    await browser.close();
  }
}

// Remove the probe entry so the sanity check leaves no feedback behind.
async function cleanupProbe(id) {
  const dir = path.join(process.cwd(), '.nitpick');
  try {
    await fs.rm(path.join(dir, `${id}.json`), { force: true });
    await fs.rm(path.join(dir, `${id}.png`), { force: true }); // meta probes save a screenshot
    const qPath = path.join(dir, 'queue.json');
    const q = JSON.parse(await fs.readFile(qPath, 'utf8'));
    q.items = (q.items || []).filter((i) => i.id !== id);
    await fs.writeFile(qPath, JSON.stringify(q, null, 2));
    pass('probe cleaned up', `.nitpick/${id}.json removed from disk and queue`);
  } catch {
    warn('probe cleaned up', `couldn't remove .nitpick/${id}.json — run from the project root, or delete the "[nitpick-sanity]" entry manually`);
  }
}

await main();
const fails = results.filter((r) => r.s === 'FAIL').length;
const warns = results.filter((r) => r.s === 'WARN').length;
console.log(`\n${fails ? '✗' : '✓'} Nitpick sanity: ${results.length - fails - warns} passed, ${warns} warnings, ${fails} failed`);
process.exit(fails ? 1 : 0);
