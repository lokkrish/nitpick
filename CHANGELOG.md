# Changelog

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
