# 📍 Nitpick

**Point at a UI bug. Get a source-located fix.**

Nitpick is a Claude Code plugin for people building Next.js apps with an AI coding agent. The
hardest part of vibe-coding a UI isn't fixing issues — it's *describing* them precisely enough
for the agent to fix the right thing. Nitpick closes that gap.

Press **`Ctrl+Shift+Q`** in your running dev app, click the element that's wrong, circle it,
type what's off, optionally paste a reference image — and Nitpick captures the **exact source
location**, the component, the styles, and an annotated screenshot. Claude then works through
your feedback queue, fixing each item at its source.

```
  Ctrl+Shift+Q  →  click element  →  annotate + comment  →  .nitpick/001.json + 001.png
                                                                      │
                            /nitpick:process  ◀───────────────────────┘
                            Claude reads each item, opens the source line, fixes it.
```

---

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
2. Press **`Ctrl+Shift+Q`**. The screen dims into pick mode.
3. **Hover** — each element highlights and shows its component + source path.
4. **Click** the element you want to report.
5. **Annotate**: circle / arrow / freehand, type your comment, and `Ctrl+V` a reference
   screenshot if you have one.
6. **Submit** (or `Esc` to cancel). It's written to `.nitpick/`.
7. Repeat for as many issues as you want — they queue up.

Then, in Claude Code:

```shell
/nitpick:process
```

Claude reads the queue, views each annotated screenshot, opens the captured source line, and
fixes the issues one by one — marking each resolved as it goes.

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

```shell
/plugin uninstall nitpick@nitpick-tools
```

To remove the scaffolded files from your app, delete `components/nitpick/`,
`app/api/nitpick/`, the layout mount, and the `.nitpick/` directory.

## License

MIT
