# 📍 Nitpick

**Point at a UI bug. Get a source-located fix.**

Nitpick is a Claude Code plugin for people building Next.js apps with an AI coding agent. The
hardest part of vibe-coding a UI isn't fixing issues — it's *describing* them precisely enough
for the agent to fix the right thing. Nitpick closes that gap.

Press **`Ctrl+Shift+. (period)`** in your running dev app, click the element that's wrong, circle it,
type what's off, optionally paste a reference image — and Nitpick captures the **exact source
location**, the component, the styles, and an annotated screenshot. Claude then works through
your feedback queue, fixing each item at its source.

```
  Ctrl+Shift+. (period)  →  click element  →  annotate + comment  →  .nitpick/001.json + 001.png
                                                                      │
                            /nitpick:process  ◀───────────────────────┘
                            Claude reads each item, opens the source line, fixes it.
```

---

> **See how it works:** open [`docs/index.html`](./docs/index.html) — an explainer with a live
> (simulated) capture demo and Install / Usage / Decommission steps for both modes (Claude-only
> and with BMAD).

## Install

Nitpick installs from this GitHub repo as a Claude Code plugin marketplace.

```shell
# 1. Add this repo as a marketplace
/plugin marketplace add <your-github-username>/nitpick

# 2. Install the plugin
/plugin install nitpick@nitpick-tools
```

> Developing locally? Point Claude Code at the folder instead:
> `/plugin marketplace add /path/to/nitpick` then `/plugin install nitpick@nitpick-tools`.

## Set up your Next.js app (one time)

From inside your Next.js project, run:

```shell
/nitpick:setup
```

Claude inspects your project (App Router vs Pages Router, `src/` or not, TS/JS) and scaffolds:

- `components/nitpick/NitpickOverlay.tsx` — the dev-only overlay
- `components/nitpick/nitpick-source.ts` — the click-to-source resolver
- `app/api/nitpick/route.ts` — the dev-only API route that writes feedback to disk
- a dev-only mount in your root layout
- a `.nitpick/` entry in `.gitignore`
- installs `html-to-image` as a dev dependency (best-effort screenshots)

Nothing Nitpick adds runs in production — the overlay and the route both hard-gate on
`NODE_ENV`.

## Use it

1. Run your app: `npm run dev`.
2. Activate: **`Ctrl+Shift+. (period)`**, double-tap **Shift**, or click the badge. A draggable
   **toolbox** appears (drag the ⠿ handle to move it).
3. Pick a tool:
   - **⌖ Inspect** — hover to highlight, click to capture an element (you can capture several).
     Each grabs the component, source line, computed styles, and Playwright-style locators
     (role + name, `getByRole`/`getByTestId`, CSS, XPath).
   - **↗ Arrow · ✎ Draw · ▭ Box** — annotate **anywhere** on the page, element or not.
   - **⬚ Area** — drag a region; it snips that section and saves just that crop (otherwise the
     capture is the **🖼 full page**).
   - **● Record** — hides the overlay and logs your clicks / inputs / **navigation** in the
     background as a repro flow; it **persists across screens** (even full page reloads). Hit
     **Stop** when done.
4. Type a comment, optionally `Ctrl+V` / drop a reference image, then **Save** (or `Esc` to cancel).
5. Repeat for as many issues as you want — they queue up in `.nitpick/`.

Then, in Claude Code:

```shell
/nitpick:process
```

Claude reads the queue, views each annotated screenshot, opens the captured source line, and
fixes the issues one by one — marking each resolved as it goes.

### Change the hotkey

The default is **`Ctrl+Shift+.`** (chosen to dodge browser/OS shortcuts like macOS
`Cmd+Shift+Q` = Log Out). Override it by passing a `hotkey` prop where you mount the overlay —
it's matched on the physical key (`event.code`), so it's keyboard-layout-proof:

```tsx
{process.env.NODE_ENV !== 'production' && (
  <NitpickOverlay hotkey={{ alt: true, shift: true, code: 'KeyN' }} />
)}
```

`code` accepts values like `'Period'`, `'Slash'`, `'Backquote'`, `'KeyN'`, `'Digit0'`;
modifiers are `ctrl`, `meta` (Cmd/Win), `alt` (Option), and `shift`.

## Use with BMAD-METHOD

If your project uses [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD), Nitpick routes
feedback through BMAD's agents instead of editing code directly — it stays a *reporting* tool and
lets the **dev** agent do the work.

```shell
/nitpick:bmad          # triage open feedback, then route it
```

Each item is triaged into one of two dispositions:

- **quick-fix** → handed straight to the BMAD **dev** agent to implement now;
- **backlog** → parked until the relevant epic is done, then `/nitpick:bmad stories <epic>`
  turns those items into BMAD **stories** the dev agent picks up via the normal flow.

`/nitpick:process` auto-detects BMAD and points you to `/nitpick:bmad` rather than editing code
behind the team's process. Two integration surfaces ship:

- the **`nitpick-bmad`** Claude Code agent (works with any BMAD version), and
- a **BMAD-native agent** — run `/nitpick:setup-bmad` to install Nitpick into `.bmad-core/agents/`
  (it reads your existing agents to match your BMAD version's format) so you activate it like any
  other BMAD agent.

## How it finds the right line of code

Nitpick resolves the clicked element to a source location with a layered strategy that
degrades gracefully (see [`DESIGN.md`](./DESIGN.md)):

1. **`data-nitpick-src`** build-time stamp (most precise; opt-in Babel plugin) →
2. **React Fiber `_debugSource`** (zero-config on React ≤ 18 / Next ≤ 14) →
3. **Component name + stack + selector + text** (every React version) — enough for Claude to
   `grep` straight to the file even without an exact line.

> **Next 15 / React 19?** React 19 removed `_debugSource`, so step 2 yields nothing there — by
> design. You still get precise component-level targeting from step 3, and exact lines if you
> enable the optional build stamp. `/nitpick:setup` will offer it.

## What gets captured

Each report is a JSON file plus images in `.nitpick/`. See the full schema in
[`DESIGN.md`](./DESIGN.md#the-data-contract-nitpicknnnjson). In short: your comment, the route,
viewport, the element's source/component/selector/styles/box, vector annotations, an annotated
screenshot of the element, and any reference image you pasted.

## Privacy & safety

- Everything stays **local** — feedback is written to `.nitpick/` in your repo. Nothing is
  sent anywhere by the overlay.
- The overlay and API route are **dev-only** and refuse to run in production.
- `.nitpick/` is gitignored by default (your call to commit it or not).

## Uninstall

Nitpick is already inert in production (the overlay returns `null` and the route returns `410`
when `NODE_ENV === 'production'`), so removal is about clean code, not safety. There are two
independent parts:

**1. Remove the scaffolded code from your app** — run the reverse of setup:

```shell
/nitpick:remove          # deletes the overlay + route, un-mounts from the layout,
                         # drops the .gitignore line, removes .nitpick/, uninstalls html-to-image
# flags: --keep-feedback (keep .nitpick/), --keep-dep (keep html-to-image)
```

Or do it by hand: delete `components/nitpick/`, `app/api/nitpick/`, the `<NitpickOverlay />`
mount in your layout, and the `.nitpick/` directory.

**2. Remove the plugin from Claude Code:**

```shell
/plugin disable nitpick@nitpick-tools     # temporary — re-enable later with /plugin enable
/plugin uninstall nitpick@nitpick-tools   # permanent
/plugin marketplace remove nitpick-tools  # optional: forget the marketplace too
```

## License

MIT
