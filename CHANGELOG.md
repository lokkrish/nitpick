# Changelog

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
