---
description: Read the Nitpick feedback queue (.nitpick/) and fix each open UI issue at its source.
argument-hint: "[id]  (optional: fix only this feedback id, e.g. 003)"
---

# Process Nitpick feedback

Work through the visual feedback the user captured with the Nitpick overlay. This is the
agent-side of Nitpick — follow the **resolving-ui-feedback** skill's workflow.

## Do this

0. **Check for BMAD first.** If the repo uses BMAD-METHOD (a `.bmad-core/` / `bmad-core/` /
   `.bmad/` directory, or BMAD agent commands under `.claude/commands/`), do **not** edit app
   code directly. Tell the user this project uses BMAD and route the feedback through it with
   **`/nitpick:bmad`** (or the `nitpick-bmad` agent) so fixes go via the dev agent / stories.
   Only continue with direct fixing below if there's no BMAD, or the user explicitly asks you to
   fix directly anyway. **Exception:** items with `captureType: "meta"` ("Fix me" reports about
   the Nitpick tool itself) are never BMAD work — handle them here per "Meta items" below.
1. Read `.nitpick/queue.json` in the project root.
   - If it's missing or has no `open` items, tell the user there's nothing queued and remind
     them to capture issues with **Ctrl+Shift+. (period)** in their running app. Stop.
2. If the user passed an id in `$ARGUMENTS`, handle only that item. Otherwise handle every
   `open` item, **oldest id first**.
3. For each item, load its full context and fix it (see "Per item" below).
4. After each fix, mark it resolved in BOTH `.nitpick/<id>.json` and `.nitpick/queue.json`
   (`status: "resolved"`, and add a short `resolution` note of what you changed).
5. End with a summary: what you fixed, where, and anything you couldn't resolve confidently
   (leave those `open` and explain why).

## Per item

For `.nitpick/<id>.json`:

- **View the images.** Read `.nitpick/<id>.png` (the annotated element — the accent-colored
  circle/arrow/drawing marks exactly what's wrong) and `<id>-ref.png` if present (the user's
  target/reference). These are the ground truth for visual issues.
- **Open the code.** If `element.source` is set, open `element.source.file` at
  `element.source.line`. If it's `null`, locate the code by `element.componentName` /
  `element.componentStack` / `element.text` / `element.selector` (grep the component name or the
  text). The `element.classes` and `element.computedStyles` tell you the current styling.
- **Understand the ask** from `comment` + the annotations + the reference image, cross-checked
  against `element.computedStyles` and `viewport` (e.g. a `viewport.width` of 390 means it's a
  mobile-width complaint — fix responsively, don't hardcode).
- **Apply a real fix** in the source. Match the project's styling approach (Tailwind classes,
  CSS modules, styled-components, etc. — infer from the file). Keep the change minimal and
  consistent with surrounding code.

## Meta items — "Fix me" reports about Nitpick itself

An item with `captureType: "meta"` is the user telling you **the Nitpick tool is broken**, not
their app. The overlay's "🛠 Fix me" button produces these. Handle them differently:

- `<id>.png` is the viewport **including the Nitpick UI** — view it to see the broken state of
  the overlay (toolbox, marquee, snip editor, badge…). The `meta` field has diagnostics:
  overlay `version`, `userAgent`, configured `hotkey`.
- **Fix the installed Nitpick copy in this project**: the overlay (`**/nitpick/NitpickOverlay.*`,
  `nitpick-source.*`) and/or the API route (`**/api/nitpick*`). Use the plugin's own templates
  at `${CLAUDE_PLUGIN_ROOT}/templates/nitpick/` as the reference implementation.
- **Check for drift first**: if `meta.version` is older than the plugin's templates, the fix is
  usually refreshing the installed copy from the current template (offer `/nitpick:setup` or
  copy the changed file) rather than patching old code.
- If the bug also exists in the plugin's template (not just this project's copy), say so
  explicitly and suggest reporting it upstream (the repo in the plugin manifest) — fix the
  local copy either way so the user is unblocked.
- After fixing, suggest `/nitpick:sanity` to verify, then mark the item resolved as usual.

Be precise and conservative: change what the feedback asks for, verify the file actually
renders that element, and don't refactor unrelated code.
