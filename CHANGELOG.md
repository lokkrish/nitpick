# Changelog

## 0.3.3

- **Inspect now saves a cropped screenshot per selected element.** Pick element 1, 2, 3, … and
  each is saved as `<id>-1.png`, `<id>-2.png`, … (also surfaced as `target.image` on every entry
  and in a `targetImages` array). Each crop uses `captureRegion(target.boundingBox)`, so it's
  correct **even if the element has scrolled off-screen** by the time you Save — verified in a real
  browser (two below-the-fold elements captured cleanly). New `captureType: "element"`.
- **Removed the standalone Draw tool.** Drawing (Arrow / Circle / Box / Pen) now lives only inside
  the **Snip** editor, where it's actually useful — the top-level Draw was redundant. The toolbox
  is now **Inspect · Snip · Record**. Page-level vector annotations are gone (`annotations` is kept
  as an empty array for back-compat); Snip drawings remain baked into the snipped image.
- The fix skill, README, and DESIGN updated for the per-element images and the slimmer toolbox.

## 0.3.2

Capture rewrite — the screenshots actually work now, at any scroll position.

- **Root cause fixed: captures only ever showed the top of the page.** `html-to-image` renders
  `document.documentElement` from the top-left and sizes the output to one viewport height, so a
  plain full-page capture never included anything below the fold — which is why Snip/Draw made
  after scrolling came out misaligned, cropped, or blank (the v0.3.1 scroll-to-top attempt made
  Draw worse, since it then composited your below-the-fold marks onto a top-of-page image).
- **New `captureRegion(box)` primitive.** We give `html-to-image` an explicit frame the size of
  the region and translate the cloned document by the region's origin, so **exactly that page
  region is captured, correct at any scroll** — and always within the browser's max-canvas size.
  - **Draw** now captures the **viewport you're looking at** and bakes the marks in where you
    drew them.
  - **Snip** now captures the **entire region you dragged** (even across an element edge), at
    full resolution, then you mark it up.
- **Record no longer captures screenshots — it saves the action flow only.** The per-screen
  shots only ever grabbed the top of each page, bloated reports, and pressured memory. A recording
  now saves just the ordered `actions` (clicks / inputs / navigations, each with route + locator).
  This also removed the whole server-side draft/streaming path (`stage`/`discard` ops, `.draft/`,
  `screens[]`).
- Removed `screens`/`region` from the report contract; the API route is back to a single simple
  save. The fix skill (`resolving-ui-feedback`) updated: recordings are read as an action flow,
  and the Draw/Snip screenshot is documented as the viewport/region (not the whole page).

## 0.3.1

- **Fix: Snip / Draw captured a misaligned or blank image after scrolling down a long page.**
  `html-to-image` renders `document.documentElement` from the page origin, but on a scrolled page
  the captured content is shifted by the scroll amount — so a snip or drawing made below the fold
  came out wrong (or empty). All captures now go through a shared `snapshotDoc()` that **scrolls to
  the top for the shot and restores the exact scroll right after** (masked by a brief
  "📸 Capturing…" overlay), so page coordinates always line up with the image.
- **Fix: Snip could fail on very tall pages.** The region crop used an uncapped device pixel ratio,
  so the intermediate full-page canvas could exceed the browser's max-canvas size. The ratio is now
  budgeted against the full page height (`cappedRatio`), so it degrades resolution gracefully
  instead of failing.
- **Removed the "＋ Elements" toggle** from Draw and Snip. It sampled the DOM element(s) under a
  mark, which was unreliable; **Inspect** already captures element targets (with Playwright-style
  locators) precisely, so use that when the report needs component details. Snip is now always
  image + comment only.

## 0.3.0 — public release 🎉

First public, open-source release.

- Polished README, landing/demo page (`docs/index.html`), and repo metadata pointing at
  `github.com/lokkrish/nitpick`.
- Open-source scaffolding: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, GitHub issue
  & PR templates, and a CI workflow that validates the plugin structure (`scripts/validate.mjs`).
- No functional change to the overlay/plugin beyond docs/metadata.

## 0.2.9

- **Fix: dev-server memory climbing to OOM even when Nitpick wasn't being used.** On every mount
  the overlay restored a prior session from `sessionStorage` and could **silently auto-resume
  recording**; after a crash/reload it would keep capturing in the background, and any URL change
  then streamed shots → the Node heap grew to GBs. The overlay now **starts clean on every page
  load** (no silent resume) — a fresh load abandons and discards any prior session — so it's fully
  inert unless actively used.
- Added hard safety caps on Record (min 1.2s between shots, max 60 per recording) as a backstop.
- Recording still works across **client-side** navigation (component stays mounted); it no longer
  persists/resumes across **full page reloads**.

## 0.2.8 — unreleased

- **Fix: `useInsertionEffect must not schedule updates` warning + capture storm during Record.**
  The history `pushState`/`replaceState` patch ran `setActions`/screenshot scheduling synchronously
  inside the call stack where Next syncs the router (a React insertion effect), and Next fires
  `replaceState` frequently (scroll/param syncs) — so every one recorded a "navigate" and queued a
  screenshot, flooding `/api/nitpick` and pushing the dev server toward its memory limit.
  Navigation handling now **defers out of that call stack** and **only records a real screen
  change** (dedupes repeated same-URL history calls), so there's one capture per actual screen.

## 0.2.7 — unreleased

- **Record now streams each screen to the dev server as it's captured** (new `stage` op →
  `.nitpick/.draft/<draftId>/`), instead of holding every image in browser memory and POSTing
  them all at Save. The browser keeps only light refs; the final Save sends just a `draftId`
  (plus actions/comment), and the server promotes the staged shots into `NNN-1.png`, `NNN-2.png`,
  … This keeps memory flat no matter how many screens are recorded.
- **Abandoned drafts are cleaned up**: cancelling/closing a session (or starting a new Nitpick)
  discards the draft on the server (new `discard` op), so unsubmitted captures don't linger.
  Draft id + refs persist in `sessionStorage`, so a recording resumes into the same draft across
  reloads.

## 0.2.6 — unreleased

- **Fix: dev-server out-of-memory on save.** Record was capturing full-page PNGs at device pixel
  ratio; on long/complex pages a multi-screen save POSTed tens of MB (sometimes GB), OOM-ing the
  Node dev server while parsing the body. Captures are now budget-limited:
  - per-screen record shots are downscaled (≤ ~1400×3000) and JPEG-encoded (≈100–300 KB each);
  - the single full-page screenshot is capped (≤ ~1600×5000);
  - retained screens capped at 12;
  - the API route rejects payloads over 40 MB with `413` (Pages Router already had a body limit).

## 0.2.5 — unreleased

- **Fix: post-recording summary showed "0".** After Stop, the toolbox status line only counted
  drawings/elements (both 0 for a recording) and never showed the screens count, so a recording
  looked empty even though Save persisted it. The toolbox now shows a clear
  **"🎬 N actions · M screens captured — add a comment, then Save"** summary whenever recording
  data exists.
- **Robustness:** on Stop, state is reconciled with the persisted `sessionStorage` store
  (covers capture spread across multiple screens), and Save falls back to the store if state is
  empty — so a recording is never saved blank.

## 0.2.4 — unreleased

- **Record now captures every screen, not just the last one.** A full-page shot is taken on
  recording start, on each navigation (debounced so the new screen renders), and on stop —
  saved as `NNN-1.png`, `NNN-2.png`, … with their routes. New `screens[]` field
  (`{ route, file }`); `captureType: "recording"`; the single `screenshot` is skipped for
  recording reports. Shots are held in memory (so client-side navigation works) and persisted
  best-effort to `sessionStorage` for full reloads. The fix skill reads each screen in order
  alongside `actions`.

## 0.2.3 — unreleased

- **Nothing highlighted by default** — the Record button no longer carries a permanent accent
  border that made it look pre-selected; the toolbox now opens with zero tools/buttons active.
- **＋ Elements** toggle in **Draw** and **Snip** — when on, the report also captures the HTML
  component details (Playwright-style locators, source/component, computed styles) of the
  element(s) under your marks (Draw → the element each shape points at; Snip → elements sampled
  inside the region), so the LLM gets full DOM context alongside the picture. Off by default.

## 0.2.2 — unreleased

Toolbox UX refinements.

- **No tool selected by default** on activation — the toolbox opens neutral (the page stays
  interactive until you pick a tool).
- **Draw** is now a group: **Arrow / Circle / Box / Pen** live under it (Circle is back, as a
  draw sub-tool). Drawn anywhere on the page as vector annotations.
- **Area → Snip**: drag a region, then **draw directly on the cropped image**; Save stores just
  that flattened image + comment. Snip drawings are **baked into the image — no coordinates are
  persisted** (`captureType: "snip"`, empty `annotations`/`targets`).
- **Record** field capture clarified: text inputs → value; `<select>` → selected option text;
  radio/checkbox → checked/unchecked (+value); password → redacted; plus clicks, submits, and
  navigation (unchanged).

## 0.2.1 — unreleased

Action recording + toolbox fixes.

- **Record tool** — hides the overlay and logs clicks / inputs / submits / **navigation** in the
  background. The flow is persisted in `sessionStorage`, so it **survives client-side and
  full-page navigations** (the session rehydrates on mount) — actions truly span multiple
  screens. Each action carries its URL + a Playwright-style locator; passwords are redacted.
  New `actions[]` field in the report (persisted by both route handlers).
- **Area** now snips that region and shows the cropped section as a thumbnail; Save stores just
  that section.
- **Removed the Circle/Ellipse tool** (kept legacy render support for old reports).
- **Fixed:** Save could stick on "Saving…" — `submitting` is now reset on success/close/open and
  in a `finally`, and screenshot capture has an 8s timeout so it can never hang.
- **Fixed:** during **Inspect**, clicking the comment box (or any toolbox control) was swallowed
  by the capture-phase blockers — they now exclude Nitpick's own UI, and Inspect stays active
  after each pick so you can keep selecting and still type a comment.

## 0.2.0 — unreleased

Overlay v2 — a real annotation toolbox.

- **Draggable toolbox** appears on activation (drag handle to move it anywhere).
- **Draw anywhere** — Arrow, Pen (freehand), Rectangle, Ellipse — over the whole page, not tied
  to an element. Annotations are stored in page coordinates and stay aligned while scrolling.
- **Screenshots**: **Full** (whole page) or **Area** (drag a region) — annotations are composited
  in; best-effort via `html-to-image`.
- **Inspect** captures one or many elements (`targets[]`) with **Playwright-style locators**:
  ARIA role + accessible name, `getByRole`/`getByText`/`getByTestId` suggestion, test-id, CSS,
  XPath, and the element's opening tag — alongside the React source/component and computed styles.
- **Free-form reports** (no element) are supported — a pure visual/region note.
- Data contract gains `captureType`, `region`, `coordSpace`, and `targets[]`; `element` remains
  as a `targets[0]` alias. Routes (App + Pages) and the fix skill updated accordingly.
- Verified on Next 16.2.7 / React 19.2.4: `tsc` + `next build` pass; the route persists the new
  fields end-to-end.
- Known follow-up: native HD capture via `getDisplayMedia` (a v2.1 toggle); the static demo page
  still shows the v1 single-element flow.

## 0.1.0 — unreleased

First cut. The full loop, end to end:

- **Overlay** (`templates/nitpick/`): Ctrl+Shift+. activation (configurable via `hotkey` prop,
  matched on `event.code`) plus a clickable launcher button, hover inspect with live
  component + source label, click to select, circle/arrow/freehand annotations, comment box,
  reference-image paste/drop, best-effort annotated screenshot of the selected element.
- **Click-to-source resolver**: layered + version-tolerant (build stamp → React Fiber
  `_debugSource` → component name/stack/selector fallback).
- **Bridge**: dev-only Next.js API route (App Router `route.ts` + Pages Router variant) that
  writes reports to `.nitpick/*.json` + images and maintains `queue.json`.
- **`/nitpick:setup`**: scaffolds the overlay, route, layout mount, gitignore, and the
  optional `html-to-image` dep into a Next.js project, adapting to App/Pages router, `src/`,
  TS/JS, and import aliases.
- **`/nitpick:process`** + **`resolving-ui-feedback`** skill: read the queue, view annotated
  screenshots, fix each issue at its source, mark resolved.
- **`/nitpick:remove`**: reverses setup — deletes the overlay + route, un-mounts from the
  layout, drops the gitignore line, and removes `.nitpick/` and the `html-to-image` dep
  (`--keep-feedback` / `--keep-dep` to retain either).

### BMAD-METHOD integration

- **Two dispositions** per item — `quick-fix` (hand to the BMAD dev agent now) and `backlog`
  (turn into BMAD stories after the relevant epic). Backward-compatible `disposition` / `epic` /
  `bmadStory` fields on each report.
- **`/nitpick:bmad`** — triage open feedback and route it (`triage` / `quick-fix <id>` /
  `backlog <id>` / `stories <epic>` / `status`).
- **`nitpick-bmad` agent** — version-independent Claude Code subagent that detects BMAD, reads
  its conventions (agent ids, story location/template), and coordinates the handoff without
  editing app code itself.
- **`/nitpick:setup-bmad`** + **`templates/bmad/nitpick-skill.md`** — installs a BMAD-native
  Nitpick agent, version-aware: on **BMAD v6** a skill at `.claude/skills/bmad-nitpick/` (routes
  quick-fix → `bmad-quick-dev`, backlog → `bmad-create-story`); on **v4** an agent file under
  `.bmad-core/agents/`. Reads existing agents/skills to match the exact format.
- **`/nitpick:process`** now detects BMAD and defers to `/nitpick:bmad` instead of editing code
  behind the team's process.
- Verified against a real **BMAD-METHOD v6.8.0** install (skills-based layout under `_bmad/` +
  `.claude/skills/bmad-*`, output to `_bmad-output/`).

### Activation

- Three ways in (so OS/browser shortcuts can't fully block it): the configurable combo, a
  **double-tap of Shift**, and the clickable badge. Activation never fires mid-annotation, so it
  can't discard an in-progress report. Logs `[Nitpick] ready …` on load.

### Verified

- Plugin + marketplace manifests pass `claude plugin validate --strict`.
- Templates typecheck (`tsc --noEmit`) and `next build` compiles against **Next 16.2.7 /
  React 19.2.4** with the overlay mounted in the root layout.
- Bridge works end-to-end in dev: POST writes `.nitpick/NNN.json` + decoded `NNN.png`,
  increments ids, and `GET` returns the queue.
- Production safety gate confirmed: a prod POST returns 410 and writes nothing.

- In-browser overlay UX on Next 16 / React 19: hotkey + clickable launcher, hover highlight,
  element picking, freehand/circle/arrow annotations, and `html-to-image` capture — exercised by
  real captures resolved through `/nitpick:process`.

### Known issues

- `html-to-image` can return a near-blank capture for a *standalone* `next/image` SVG;
  capturing a larger container element works fine. Tracked for 0.2.0.
- On App Router, Server Components have no client fiber, so `componentName` falls back to
  framework internals — element targeting still works via selector/class/screenshot, and the
  optional build-stamp recovers exact `file:line`.

### Not verified yet

- Reference-image paste/drop into a report.

### Not yet (planned for 0.2.0+)

- MCP live-push so new feedback appears without `/nitpick:process`.
- Multi-element / region batches in one report.
- Optional native Screen Capture API for pixel-perfect screenshots.
