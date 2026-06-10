<div align="center">

# 📍 Nitpick

### Point at a UI bug in your running app. Get a source-located fix.

**A [Claude Code](https://claude.com/claude-code) plugin for Next.js — with first-class [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) support.**

Press a hotkey, circle the element that's wrong, say what's off — Nitpick captures the exact
component, source line, Playwright-style locators, and an annotated screenshot, then Claude (or
your BMAD dev agent) fixes each report at its source.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-da7756)](https://code.claude.com/docs/en/plugins)
[![Works with BMAD-METHOD](https://img.shields.io/badge/BMAD--METHOD-v6-7a5cff)](https://github.com/bmad-code-org/BMAD-METHOD)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/lokkrish/nitpick?style=social)](https://github.com/lokkrish/nitpick)

[**Quickstart**](#-quickstart-claude-code) · [**With BMAD**](#-with-bmad-method) · [**How it works**](#-how-it-works) · [**Live demo**](https://lokkrish.github.io/nitpick/) · [**Commands**](#-command-reference)

</div>

<div align="center">

<!-- Add an animated demo at docs/demo.gif and it renders here. -->
<img src="./docs/demo.gif" alt="Nitpick demo" width="760" onerror="this.style.display='none'">

</div>

---

## Why Nitpick

When you build a UI with an AI coding agent, the hard part isn't *fixing* issues — it's
**describing** them precisely. "The card padding looks off" makes the agent guess which card,
which file, which line. Round-trips pile up.

Nitpick removes the guessing. You **point at the broken element in the running app**, and the
agent receives the comment already mapped to a source location — with the component, the styles,
Playwright-style locators, and a screenshot. Reporting and fixing stay cleanly separated.

```
  hotkey → circle element → comment → .nitpick/001.json + 001.png
                                              │
                  /nitpick:process  ◀──────────┘   (or routed to your BMAD dev agent)
                  Claude opens the source line and fixes it.
```

## ✨ Features

- 🎯 **Inspect → source** — click any element to capture its **React source line**, component
  stack, computed styles, **Playwright-style locators** (`getByRole`, `getByTestId`, CSS, XPath),
  **and a cropped screenshot of each selected element** (`<id>-1.png`, `<id>-2.png`, …).
- ✂️ **Snip** — crop a region (correct at any scroll), mark it up with Arrow / Circle / Box / Pen,
  save it as a flat annotated image.
- 🎬 **Record a flow** — capture clicks, field inputs (text / dropdown / radio / checkbox), and
  **navigation across multiple screens** as an ordered repro script (each step with its route and
  a Playwright-style locator).
- 🧰 **Draggable toolbox**, configurable hotkey (or double-tap Shift, or a click).
- 🤝 **BMAD-METHOD aware** — route feedback to the dev agent now, or into stories after an epic.
- 🔒 **Dev-only & report-only** — never runs in production, never changes your app's behavior;
  everything stays local in `.nitpick/`.

## 🚀 Quickstart (Claude Code)

```shell
# 1. Add the marketplace + install (in Claude Code)
/plugin marketplace add lokkrish/nitpick
/plugin install nitpick@nitpick-tools

# 2. Scaffold the overlay into your Next.js app
/nitpick:setup
npm run dev          # (re)start your dev server
```

Then, in the browser:

1. Activate: **`Ctrl+Shift+.`**, double-tap **Shift**, or click the **📍 Nitpick** badge.
2. Pick a tool — **Inspect**, **Snip**, or **Record** — annotate, add a comment,
   optionally paste a reference image, and **Save**.
3. Repeat; reports queue in `.nitpick/`.

Back in Claude Code:

```shell
/nitpick:process     # Claude views each screenshot, opens the source line, and fixes it
```

## 🤝 With BMAD-METHOD

Using [BMAD](https://github.com/bmad-code-org/BMAD-METHOD)? Route feedback through its agents
instead of editing code directly:

```shell
/nitpick:setup-bmad  # installs a BMAD-native "nitpick" agent (v6 skill / v4 agent)
/nitpick:bmad        # triage feedback, then route it
```

Each item is triaged into **quick-fix** (handed to the dev agent now) or **backlog** (turned into
BMAD **stories** with `/nitpick:bmad stories <epic>` once the epic is done). Verified against
**BMAD-METHOD v6.8**.

## 🧠 How it works

Nitpick is **two artifacts joined by a file bridge** (full writeup in [`DESIGN.md`](./DESIGN.md)):

| Part | Where it runs | What it does |
| --- | --- | --- |
| **Overlay** (`templates/`) | the browser (dev-only) | capture: hotkey, annotate, screenshot, locators |
| **Bridge** (dev API route) | your Next.js dev server | writes reports to `.nitpick/*.json` + images |
| **Plugin** (this repo) | Claude Code | `/nitpick:*` commands + skill + BMAD agent that fix the queue |

Screenshots capture **exactly the region you're looking at** (correct at any scroll position),
Record saves the **action flow only** (no images), and the overlay is **completely inert when
idle** — no background work, no memory growth.

## 🎛 Command reference

| Command | What it does |
| --- | --- |
| `/nitpick:setup` | Scaffold the overlay + dev API route into a Next.js app (App or Pages router). |
| `/nitpick:process` | Fix the `.nitpick/` queue in Claude (defers to BMAD if detected). |
| `/nitpick:bmad` | Triage + route feedback through BMAD (`triage` / `quick-fix` / `backlog` / `stories` / `status`). |
| `/nitpick:setup-bmad` | Install the BMAD-native Nitpick agent. |
| `/nitpick:remove` | Reverse setup — remove overlay, route, mount, `.nitpick/`, and the dep. |

## 🔒 Privacy & safety

- **Local-only** — feedback is written to `.nitpick/` in your repo; the overlay sends nothing
  anywhere else.
- **Dev-only** — the overlay returns `null` and the API route returns `410` in production.
- **Report-only** — Nitpick never edits your app or changes its behavior; fixing is a separate,
  explicit step.

## 🗑 Uninstall

```shell
/nitpick:remove                          # remove scaffolded code from your app
/plugin uninstall nitpick@nitpick-tools  # remove the plugin from Claude Code
```

## 🛣 Roadmap

- Native HD capture (`getDisplayMedia`) toggle for pixel-perfect shots on huge pages.
- MCP live-push (no "go process" step).
- React SPA (Vite / CRA) bridge.
- Multi-element batches.

See [`CHANGELOG.md`](./CHANGELOG.md) for what's shipped.

## 🤝 Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Be kind; we follow a
[Code of Conduct](./CODE_OF_CONDUCT.md).

## 📄 License

[MIT](./LICENSE) © Lokeshwaran

<div align="center">

**If Nitpick saves you round-trips, please ⭐ the repo — it really helps.**

</div>
