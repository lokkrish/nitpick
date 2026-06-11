---
description: Verify a Nitpick installation end-to-end — static integrity checks plus a real-browser test that selection works in all four corners of the page.
argument-hint: "[dev server url, default http://localhost:3000]"
---

# Nitpick sanity check

Verify that `/nitpick:setup` produced a working installation. Two phases: **static integrity
checks** on the scaffolded files, then a **live browser test**
(`${CLAUDE_PLUGIN_ROOT}/templates/nitpick/sanity.mjs`) that activates the overlay in a real
Chromium and verifies — among other things — that a Snip marquee can be dragged in **all four
corners of the viewport**, with and without a hostile host CSS reset. Everything is report-only:
nothing in the user's app is modified, and the one probe report the browser test saves is
deleted again automatically.

If `$ARGUMENTS` contains a URL, use it as the dev server address; otherwise default to
`http://localhost:3000`.

## Phase 1 — static integrity checks

Locate the installation by searching (setup adapts paths per project — App vs Pages Router,
`src/`, JS/TS), then check each item and keep a pass/fail list:

1. **Overlay files** — a `nitpick/` components folder containing `NitpickOverlay.*` and
   `nitpick-source.*`.
2. **Mount** — grep for `NitpickOverlay` in the root layout (App Router) or `_app` (Pages
   Router): the import plus a render guarded by `process.env.NODE_ENV !== 'production'`.
3. **API route** — `**/api/nitpick/route.{ts,js}` or `**/api/nitpick.{ts,js}`. Flag an
   underscore-prefixed folder (`api/_nitpick`) as a failure — the App Router excludes it from
   routing and the overlay's POSTs would 404.
4. **Dev-only gates** — the route checks `NODE_ENV` (production → 410) and the overlay returns
   `null` in production.
5. **Gitignore** — `.nitpick/` is listed (warn, not fail, if missing).
6. **Screenshot dependency** — `html-to-image` in the project's dependencies (warn if missing:
   snips and element images will be skipped, reports still save).
7. **Template drift** — diff the installed `NitpickOverlay` against
   `${CLAUDE_PLUGIN_ROOT}/templates/nitpick/NitpickOverlay.tsx`. Identical → pass. Different →
   warn and summarize the drift; an older copy may predate important fixes (e.g. pre-0.4.0
   copies break under `svg { height: auto }` host resets — exactly what Phase 2 catches).
   Skip the diff for JS-converted installs (setup strips types); just report the version
   comment if present. **Never overwrite the user's copy here** — offer to re-run
   `/nitpick:setup` if it's stale.

Report the list before moving on. If the overlay or route is missing entirely, stop and point
the user at `/nitpick:setup`.

## Phase 2 — live browser test

1. **Dev server** — confirm the URL responds. If not, offer to start the dev server yourself
   (background it) or let the user start it; don't proceed until it's up.
2. **Playwright** — the script resolves `playwright` (or `playwright-core` /
   `@playwright/test`) from the project. If none is installed, ask before installing
   (`npm i -D playwright && npx playwright install chromium` — it's a sizable download, use the
   project's package manager). If the user declines, skip to the manual checklist below.
3. **Run it from the project root** (cwd matters — Playwright resolution and probe cleanup both
   use it):

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/templates/nitpick/sanity.mjs" --url=<dev-url>
   node "${CLAUDE_PLUGIN_ROOT}/templates/nitpick/sanity.mjs" --url=<dev-url> --color-scheme=dark
   ```

   **Run it twice — light and dark.** Capture bugs can be scheme-dependent (a broken capture
   once looked "fine" in light mode because blank-white resembles a white page, while dark mode
   showed solid black). The script prints one `[PASS]`/`[WARN]`/`[FAIL]` line per check and
   exits 0/1 (2 = couldn't run). It verifies: overlay mounts and activates; the capture layer
   spans the full viewport; `elementFromPoint` and a real marquee drag succeed at **top-left,
   top-right, bottom-left, bottom-right**; the full snip pipeline (capture → editor → **captured
   pixels match a native screenshot of the same region** → draw → Esc); the same geometry,
   corner, and snip checks again **with an injected hostile reset**
   (`img, svg, video { max-width: 100%; height: auto }`); Esc deactivation; the **Fix me** meta
   round-trip; and a POST → save → cleanup round-trip through `/api/nitpick`.

## Phase 3 — report and diagnose

Present a single summary table (check · result · note). For failures, map to the likely cause
and offer the fix:

- **Corner/coverage failures only under the hostile reset, or layer ≪ viewport** → the
  installed overlay predates v0.4.0 (svgs sized by presentation attributes); re-run
  `/nitpick:setup` to refresh the copy.
- **"snip pixels match the page" fails (blank/black/shifted captures)** → the installed overlay
  predates v0.4.1 (region capture used a root transform that modern Chromium ignores when
  rasterizing); re-run `/nitpick:setup` to refresh the copy.
- **Badge never appears** → overlay not mounted in the root layout, or the dev server is
  running a production build.
- **API bridge failure** → route at the wrong path / underscore-prefixed folder / Pages-vs-App
  mismatch.
- **`html-to-image` warning** → install it for screenshots; reports still work without it.
- **Probe cleanup warning** → delete the `"[nitpick-sanity]"` entry from `.nitpick/` manually.

Confirm afterwards that `.nitpick/` contains no leftover `[nitpick-sanity]` probe (remove it if
the script couldn't).

### Manual fallback (no Playwright)

If the browser test can't run, give the user this 60-second manual check and offer to verify
the results with them:

1. Open the app, activate Nitpick (badge or Ctrl+Shift+.), arm **Snip**.
2. Drag a small marquee in **each of the four corners** — each must show the dashed selection
   rectangle (no native text selection).
3. Complete one snip, draw an arrow on it, Esc.
4. In DevTools: `document.querySelector('div[data-nitpick-ui="root"] svg').getBoundingClientRect()`
   must report the full viewport size (not 150px tall).
5. Save one feedback with a comment, confirm `.nitpick/<id>.json` appears, then delete it.
