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
  "viewport": { "width": 390, "height": 844, "dpr": 2 },
  "element": {
    "source": { "file": "components/Card.tsx", "line": 42, "column": 7 } | null,
    "componentName": "Card",
    "componentStack": ["Card", "DashboardGrid", "DashboardPage"],
    "selector": "main > div.grid > div:nth-child(2)",
    "tag": "div",
    "id": "",
    "classes": ["card", "p-2"],
    "text": "Upgrade",
    "dataAttributes": { "testid": "upgrade-card" },
    "boundingBox": { "x": 12, "y": 200, "width": 180, "height": 64 },
    "computedStyles": { "padding": "8px", "display": "flex", "...": "relevant subset" }
  },
  "annotations": [
    // coords are normalized 0..1 relative to the element's bounding box, so they stay
    // meaningful regardless of screenshot success ("circle at 80% across, 30% down").
    { "type": "circle", "cx": 0.8, "cy": 0.3, "rx": 0.15, "ry": 0.2 },
    { "type": "arrow", "x1": 0.1, "y1": 0.1, "x2": 0.5, "y2": 0.5 },
    { "type": "pen", "points": [[0.1,0.2],[0.15,0.25]] }
  ],
  "screenshot": "001.png",                // annotated element capture, or null if unavailable
  "referenceImage": "001-ref.png"         // optional, user-supplied
}
```

`.nitpick/queue.json` is the index: `{ "items": [{ "id", "status", "comment", "route" }], "nextId": 4 }`.

## The fix loop (`skills/resolving-ui-feedback/SKILL.md`)

Triggered by `/nitpick:process` or when the user mentions processing UI feedback:

1. Read `.nitpick/queue.json`; list `open` items oldest-first.
2. For each: read `NNN.json`, **view** `NNN.png` and `NNN-ref.png` if present, open the source
   at `element.source.file:line` (or grep by component/text when source is null).
3. Apply the fix; set the item `status: "resolved"` in both `NNN.json` and `queue.json` with a
   one-line note of what changed.
4. Move to the next; summarize at the end.

## Why screenshots capture only the selected element

`html-to-image` snapshots a single DOM node cleanly. Capturing the **selected element** (not
the whole page) means annotation coordinates — stored element-relative — composite onto the
image with zero scroll/viewport math, and the picture is exactly "the thing being complained
about." Best-effort: if `html-to-image` is absent or throws, we still send vector annotations
+ full metadata, and the item stays fully actionable.

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
