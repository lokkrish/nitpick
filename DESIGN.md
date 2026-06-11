# Nitpick — Design & Architecture

> Durable record of *why* Nitpick is built the way it is. Read this before changing the
> architecture. Implementation lives in `templates/`, `commands/`, and `skills/`.

## The problem

When building a large app with an AI coding agent, the hardest part is **communicating a UI
issue precisely**. "The card padding looks off" forces the agent to guess which card, which
file, which line. Round-trips pile up. Nitpick removes the guessing: the human points at the
exact rendered element, annotates it, and the agent receives the comment *already mapped to a
source location* plus a picture of the problem.

## The core insight: two artifacts + a bridge

A Claude Code plugin runs in the **terminal/agent** context. It cannot render anything in the
browser. The overlay (Ctrl+Shift+. (period), dim screen, circle an element) is **browser code that must
live inside the user's Next.js app** (dev-only). So Nitpick is necessarily three parts:

```
┌─────────────────────────┐         ┌──────────────────────────┐
│  BROWSER (the Next app)  │         │  TERMINAL (Claude Code)  │
│                          │  writes │                          │
│  NitpickOverlay (dev):  │ ──────▶ │  Plugin:                 │
│  • Ctrl+Shift+. (period) activate │ .nitpick/  • skill: resolve queue │
│  • hover → highlight el   │  files  │  • /nitpick:process     │
│  • circle / arrow / note │         │  • /nitpick:setup       │
│  • paste reference image │ ◀────── │                          │
│  • POST to dev API route │  reads  │  reads queue, fixes each │
└─────────────────────────┘  + marks └──────────────────────────┘
        the BRIDGE = a dev-only Next API route writing .nitpick/*.json + *.png
```

1. **The overlay** (`templates/nitpick/NitpickOverlay.tsx`) — injected into the user's app,
   dev-only. Captures annotations + element metadata.
2. **The bridge** (`templates/nitpick/route.ts`) — a dev-only Next.js API route that writes
   captured feedback to a `.nitpick/` directory in the repo.
3. **The plugin** (this repo) — a `/nitpick:setup` command that scaffolds 1 & 2 into the
   user's app, plus a skill + `/nitpick:process` command that reads `.nitpick/` and fixes
   each item.

## Locked design decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Distribution | One self-contained plugin that **scaffolds** the overlay in via `/nitpick:setup` | Single install from GitHub; no separate npm package to version. |
| Bridge | **File-based**: overlay POSTs to a dev API route → `.nitpick/*.json + *.png` | Offline, version-control-visible, restart-proof, and Claude's Read tool sees PNGs directly. MCP live-push is a v2 upgrade. |
| Capture focus | **Source-line + vector annotations**, screenshot best-effort | Source location + comment + styles make most fixes one-shot; screenshots are a bonus, not the foundation. |

## Source-line resolution (the layered resolver)

Mapping a clicked pixel → a line of code is the highest-value capture. It is also the most
version-sensitive part. `templates/nitpick/nitpick-source.ts` tries, in order:

1. **`data-nitpick-src` attribute** — written at build time by the optional Babel plugin
   (`templates/babel-plugin-nitpick.js`). Deterministic and version-proof. Opt-in because
   enabling Babel in Next.js disables SWC.
2. **React Fiber `_debugSource`** — present on host fibers in **React ≤ 18 / Next ≤ 14** with
   zero config (Next dev injects it). **Removed in React 19 / Next 15+** — so this path simply
   yields nothing there, which is expected, not a bug.
3. **Component name + stack + selector + text** (always available) — walking the fiber
   `return` chain to collect composite component names works across all React versions because
   it does not depend on `_debugSource`. Combined with a robust CSS selector and the element's
   text, this lets Claude `grep` the component to the right file even with no exact line.

So: exact `file:line` when available, always-actionable metadata otherwise. The resolver never
throws; missing data is `undefined`, and the skill is written to handle that.

## The data contract (`.nitpick/NNN.json`)

This is the interface between browser and agent — keep it stable.

```jsonc
{
  "id": "001",
  "status": "open",                       // open | resolved
  "createdAt": "2026-06-07T12:00:00.000Z",
  "comment": "Padding too tight; button overflows on mobile",
  "route": "/dashboard",
  "viewport": { "width": 390, "height": 844, "dpr": 2, "scrollX": 0, "scrollY": 120 },
  "captureType": "element" | "snip" | "recording" | "full" | "meta", // how the report was made
  "coordSpace": "page",                   // boxes are PAGE coords (incl. scroll)
  // `targets` = every element the user Inspected (0..n). `element` = targets[0] (back-compat).
  "targets": [
    {
      "source": { "file": "components/Card.tsx", "line": 42, "column": 7 } | null,
      "componentName": "Card",
      "componentStack": ["Card", "DashboardGrid", "DashboardPage"],
      "tag": "button", "id": "", "classes": ["cta"], "text": "Upgrade",
      "dataAttributes": { "testid": "upgrade-card" },
      "locators": {                       // Playwright-style, for precise targeting
        "role": "button",
        "name": "Upgrade",
        "testId": { "attr": "data-testid", "value": "upgrade-card" } | null,
        "getBy": "getByRole('button', { name: \"Upgrade\" })",
        "css": "main > div.grid > button.cta",
        "xpath": "/html/body/main/div[1]/button[1]",
        "outerTag": "<button class=\"cta\" data-testid=\"upgrade-card\"></button>"
      },
      "boundingBox": { "x": 12, "y": 200, "w": 180, "h": 64 },
      "computedStyles": { "padding": "8px", "display": "flex", "...": "relevant subset" },
      "image": "001-1.png"                 // cropped screenshot of THIS element (Inspect)
    }
  ],
  "element": { /* = targets[0], or null for a free-form (no-element) report */ },
  "targetImages": ["001-1.png", "001-2.png"], // one crop per Inspected element, in order
  "annotations": [],                      // reserved; snip drawings are baked into the image
  // recorded interaction flow (Record tool) — spans screens, in order; ACTIONS ONLY (no images)
  "actions": [
    { "type": "navigate", "at": "...", "url": "/" },
    { "type": "click", "at": "...", "url": "/", "locator": { "getBy": "getByRole('link', { name: \"About\" })" }, "text": "About" },
    { "type": "navigate", "at": "...", "url": "/about" },
    { "type": "input", "at": "...", "url": "/about", "locator": { "getBy": "getByRole('textbox', { name: \"Email\" })" }, "value": "a@b.com" }
  ],
  "screenshot": "001.png",                // snip/full/meta reports; null for element & recording reports
  "referenceImage": "001-ref.png",        // optional, user-supplied
  // "Fix me" reports only — diagnostics for fixing the TOOL (null otherwise)
  "meta": { "tool": "nitpick", "version": "0.4.0", "userAgent": "…", "hotkey": "Ctrl+Shift+." }
}
```

`.nitpick/queue.json` is the index: `{ "items": [{ "id", "status", "comment", "route" }], "nextId": 4 }`.

**Tools (v0.4.0):** the toolbox is **Inspect**, **Snip**, **Record**, and **Fix me** — there is
no longer a standalone Draw tool (drawing lives inside the Snip editor, where it's most useful).
`targets` is a list because a report can reference zero or many Inspected elements; a report with
`targets: []` is a pure visual/region note. `element` stays as a `targets[0]` alias for backward
compatibility.

**Fix me — meta reports (v0.4.0):** feedback about **Nitpick itself** flows through the same
queue, flagged `captureType: "meta"`. Two deliberate inversions: the screenshot **includes the
Nitpick UI** (every other capture excludes it via the `data-nitpick-ui` filter — for a tool bug
the overlay *is* the subject; only the transient "Capturing…" curtain is filtered), and the
`meta` field carries tool diagnostics (`version` from the overlay's `NITPICK_VERSION` constant —
CI keeps it in sync with plugin.json — plus `userAgent` and the configured `hotkey`). The
comment can be typed or **dictated** (Web Speech, feature-detected; mic button only renders
where the API exists). On the agent side, `/nitpick:process` and the skill treat meta items as
tool bugs: fix the **installed Nitpick copy** against the plugin templates (version drift →
refresh the stale copy), never route them to BMAD. Older installed routes that predate the
`meta` field drop it harmlessly — `captureType` still survives, so the flow degrades gracefully.

**Per-element images (v0.3.3):** **Inspect** now saves a **cropped screenshot of each selected
element** — `<id>-1.png` for the 1st element, `<id>-2.png` for the 2nd, and so on (also surfaced
as `target.image` on each entry and in `targetImages`). Each crop is produced by
`captureRegion(target.boundingBox)`, so it's correct **even if the element has scrolled off-screen**
by the time you Save (verified in a real browser). There is no whole-page `<id>.png` for an
Inspect report — the per-element crops are the picture.

**Actions recorder (v2.1):** the **Record** tool hides the overlay and logs the user's
clicks / inputs / submits / navigations in the background. Each action carries the URL +
Playwright-style locator, so `actions` reads like a repro script the dev (or BMAD dev agent) can
replay. Password inputs are redacted to `***`. Recording lives in component memory and **survives
client-side navigation** (the overlay stays mounted), so a flow can span multiple screens; it is
not resumed across full page reloads. The overlay is completely inert unless you actively use it.

**Record is action-flow only (v0.3.2).** Earlier versions also captured a screenshot per screen
visited (`screens[]`, streamed to a server-side `.draft/`). That whole path is **gone**: the
per-screen shots only ever captured the top of the page (an `html-to-image` limitation, see
below), bloated reports, and were a memory-pressure source. A recording now saves just the
ordered `actions` — which already pinpoint *what* the user did and *where* (route + locator).
Use **Snip** or **Inspect** when a picture is needed.

**Snip (v2.2, markup expanded in v0.4.0):** **Snip** crops a region and lets the user mark up
the cropped image — **Arrow / Line / Circle / Box / Pen / Text** (Text places a textarea at the
click point; Enter/blur commits, Esc cancels). All markup is **baked into the image** (no
coordinates stored) and saved as the screenshot. A snip is always image + comment only
(`targets: []`). When the LLM needs DOM/component details for an element, use **Inspect** (which
captures `targets[]` with Playwright-style locators).

> The old **＋ Elements** toggle on Draw/Snip was removed in v0.3.1 — it sampled elements under a
> mark, which was unreliable, and **Inspect** already covers that need precisely.

## The fix loop (`skills/resolving-ui-feedback/SKILL.md`)

Triggered by `/nitpick:process` or when the user mentions processing UI feedback:

1. Read `.nitpick/queue.json`; list `open` items oldest-first.
2. For each: read `NNN.json`, **view** `NNN.png` and `NNN-ref.png` if present, open the source
   at `element.source.file:line` (or grep by component/text when source is null).
3. Apply the fix; set the item `status: "resolved"` in both `NNN.json` and `queue.json` with a
   one-line note of what changed.
4. Move to the next; summarize at the end.

## Screenshots — bounded region capture (v0.3.2)

This is the part that was repeatedly broken, so it's worth stating the root cause plainly.

`html-to-image` renders `document.documentElement` from the page's top-left and — left to itself
— sizes the output to the element's **client** height, i.e. **one viewport tall**. So a naive
`toPng(document.documentElement)` only ever captures the **top** of the page. Compositing
below-the-fold annotations onto that image put them off-canvas (the "screenshot shows the top,
no marks" bug); cropping a snip at page coordinates from it failed for the same reason.

The fix is a single primitive, `captureRegion(box)` (`box` in **page coordinates**):

- give `html-to-image` an **explicit frame** the exact size of the region (`width`/`height`), and
- apply `style: { transform: translate(-box.x, -box.y) }` to the cloned document,

so exactly `[x, y, w, h]` of the page is rendered into the frame — **correct at any scroll
position**, and always within the browser's max-canvas size because the frame is a region, never
the whole long page. Everything builds on it:

- **Inspect** → `captureRegion(target.boundingBox)` per element → `<id>-1.png`, `<id>-2.png`, …
  (correct even for elements that have scrolled off-screen by Save time).
- **Snip** → `captureRegion(snipBox)` renders precisely the dragged region — the full snipped
  area, even if it straddles an element edge — which you then mark up; those marks are baked into
  the image (no coordinates stored).
- **Comment-only** → `captureRegion(viewport)` for a context shot (`<id>.png`).

Capture is **best-effort**: if `html-to-image` is absent or throws, the report still saves with
its comment + metadata (and, for Inspect, full element targets) and stays actionable. A brief
"📸 Capturing…" overlay (excluded from the capture) shows while a shot is produced.

A native HD path (`navigator.mediaDevices.getDisplayMedia`) would give pixel-perfect captures
(and fix `html-to-image`'s blank-`next/image` quirk) at the cost of a per-use permission prompt
— tracked as a future toggle, not the default.

## Overlay styling — survive arbitrary host CSS (v0.4.0)

The overlay is portaled into `document.body` of an app whose stylesheets we don't control, so it
**cannot assume a neutral cascade**. The field bug that forced this rule: a common reset
(`img, svg, video { max-width: 100%; height: auto }`) collapsed the Snip capture layer to the
SVG intrinsic default (300×150) because the layer was sized with `width`/`height` **presentation
attributes**, which lose to *any* stylesheet rule — Snip only worked in the top 150px of the
viewport. The invariant:

- **Dimension-critical overlay elements are sized with inline styles only** (`width`/`height`/
  `maxWidth: 'none'` in `style={}`) — inline styles beat every host stylesheet. Never use SVG
  width/height presentation attributes.
- CI enforces this (`scripts/validate.mjs` fails on `<svg …width=`/`height=` and on a missing
  `maxWidth: 'none'`), and `/nitpick:sanity` tests it live by injecting that exact hostile reset
  and re-checking geometry, corner hits, and the snip pipeline.

## Verification — `/nitpick:sanity`

Setup can silently go wrong (stale overlay copy, wrong route path, hostile host CSS), so the
plugin ships its own end-to-end check. `/nitpick:sanity` runs static integrity checks (files,
mount, route path, dev-only gates, drift vs the plugin templates), then drives a real Chromium
(Playwright, resolved from the user's project) through
`templates/nitpick/sanity.mjs`: activation, **full-viewport capture-layer geometry**, marquee
drags in **all four corners**, the complete snip pipeline (capture → editor → draw → Esc), the
same checks under the injected hostile reset above, Esc deactivation, the **Fix me** meta
round-trip, and an `/api/nitpick` save round-trip. Every probe report it creates is deleted
afterwards — the suite leaves no feedback behind. The DOM hooks it drives the overlay through
(`data-nitpick-ui="root"`, the badge title, `alt="snip"`, the marquee dasharray, the Fix me
button) are part of the overlay's contract and CI-checked.

## Safety / scope rules

- The overlay mounts **only** when `process.env.NODE_ENV !== 'production'`.
- The API route **refuses** to run in production (returns 404/410) so it never ships writable.
- All writes are confined to `.nitpick/` under the project root.

## BMAD integration

Nitpick stays a *reporting* tool; how a report gets fixed is pluggable. By default
`/nitpick:process` fixes items directly in Claude. When a project uses
[BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD), feedback should instead flow through
BMAD's agents, with **two dispositions** the triager assigns per item:

- **`quick-fix`** — small, obvious, safe-now items handed straight to the BMAD **dev** agent
  (bmad-dev) to implement immediately.
- **`backlog`** — items parked until the relevant EPIC completes, then triaged into BMAD
  **stories** so the dev agent picks them up through the normal flow.

### Data model additions (backward compatible)

Each `.nitpick/<id>.json` (and its `queue.json` entry) may carry:

```jsonc
"disposition": "quick-fix" | "backlog" | null,   // null = untriaged
"bmadStory": "docs/stories/3.4.ui-card-padding.md" | null,  // set when a story is created
"epic": "3" | null                               // optional: which epic this belongs under
```

Absent fields mean "untriaged" — older reports keep working.

### Two integration surfaces (the "both" agent form)

1. **Plugin-side Claude Code subagent** `agents/nitpick-bmad.md` — version-independent. Detects
   BMAD in the repo, triages `.nitpick/` items into quick-fix vs backlog, hands quick-fixes to
   the dev agent, and converts backlog items into stories on request. Works even if BMAD isn't
   wired as Claude commands. Entry point: `/nitpick:bmad`.
2. **BMAD-native agent** `templates/bmad/nitpick-skill.md` — installed by `/nitpick:setup-bmad`,
   which detects the BMAD version and installs the matching artifact:
   - **v6** (verified against BMAD 6.8.0): a Claude **skill** at `.claude/skills/bmad-nitpick/`
     that routes quick-fix → the `bmad-quick-dev` skill and backlog → `bmad-create-story`
     (output under `_bmad-output/implementation-artifacts`, per `_bmad/bmm/config.yaml`).
   - **v4** (legacy): a persona agent file under `.bmad-core/agents/`.
   The installer reads the project's existing skills/agents to match the exact format rather than
   assuming.

### Routing rules

- `/nitpick:process` detects BMAD (`.bmad-core/`, `bmad-core/`, or BMAD agent commands under
  `.claude/commands/`). If found, it does **not** silently edit code — it points to
  `/nitpick:bmad` (or asks) so fixes go through the chosen BMAD path. With no BMAD, it fixes
  directly as before.
- Nitpick only ever **writes `.nitpick/` and BMAD story files** (when asked); it never bypasses
  the dev agent to change app code under BMAD unless the user picks the direct-fix path.

## Roadmap

- **v1 (this):** hotkey → pick → annotate → comment → reference image → file bridge → skill fix loop.
- **v1.1:** BMAD integration — `/nitpick:bmad`, the `nitpick-bmad` subagent, quick-fix vs
  backlog dispositions, and a BMAD-native agent file.
- **v2:** MCP live-push (no "go process" step), multi-element batches, native Screen Capture
  API option, a small in-terminal review/triage UI, React SPA (Vite/CRA) bridge.
