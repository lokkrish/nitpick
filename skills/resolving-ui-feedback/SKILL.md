---
name: resolving-ui-feedback
description: >-
  Resolve UI issues captured by the Nitpick overlay. Use when the user asks to process UI
  feedback, fix issues from the .nitpick queue, address visual/design feedback, or mentions
  Nitpick feedback. Reads .nitpick/*.json + annotated screenshots and fixes each at its source.
---

# Resolving Nitpick UI feedback

Nitpick lets the user point at a broken UI element in their running Next.js app (Ctrl+Shift+Q),
annotate it, and save a precise, source-located report. Your job is to turn each report into a
correct code fix. (For how reports are produced and the full data contract, see the plugin's
`DESIGN.md`.)

## When to use this

- The user runs `/nitpick:process`, or asks to "process UI feedback", "fix the nitpick
  issues", "go through .nitpick", or similar.
- You notice new/open items in `.nitpick/queue.json` and the user wants them addressed.

## The queue

- `.nitpick/queue.json` is the index: `{ "items": [{ id, status, comment, route }], "nextId" }`.
- Each report is `.nitpick/<id>.json`, with optional images `<id>.png` (annotated element) and
  `<id>-ref.png` (user reference).
- Process **open** items oldest-id-first, one at a time, unless the user scopes to one id.

## Workflow

1. **Load the queue.** Read `.nitpick/queue.json`. No open items → say so and remind the user
   to capture issues with Ctrl+Shift+Q. Done.
2. **For each open item** (`.nitpick/<id>.json`):
   a. **See it.** Read `<id>.png` — the accent-colored circle/arrow/freehand marks the exact
      problem area. Read `<id>-ref.png` if present — that's the user's target look.
   b. **Locate the code.**
      - `element.source` set → open `element.source.file` at `element.source.line`.
      - `element.source` null (expected on React 19+ without the build stamp) → find it via
        `element.componentName` / `componentStack` (grep the component), then narrow with
        `element.text`, `element.selector`, and `element.classes`.
   c. **Diagnose.** Combine `comment` + annotations + reference image with the live facts:
      `element.computedStyles` (current values), `element.boundingBox`, and `viewport`
      (`viewport.width` ≈ 390/430 → a mobile complaint; fix responsively, never hardcode px for
      one width). The annotations' normalized coords are relative to the element box
      (`cx:0.8, cy:0.3` ≈ 80% across, 30% down).
   d. **Fix at the source.** Edit the real component. Match the project's styling system
      (Tailwind / CSS modules / styled-components / inline — infer from the file and neighbors).
      Keep edits minimal and idiomatic; don't refactor unrelated code.
   e. **Mark resolved.** Set `status: "resolved"` and add a one-line `resolution` note in BOTH
      `.nitpick/<id>.json` and the matching entry in `.nitpick/queue.json`.
3. **Summarize.** List each item: id, the fix, and the file:line touched. For anything you
   can't resolve with confidence, leave it `open`, explain why, and ask the user for the
   missing detail.

## Principles

- **The screenshot is ground truth** for visual issues — trust what the marks point at over a
  vague comment.
- **Verify before editing:** confirm the file you're about to change actually renders the
  reported element (text/classes/component should line up). If the source line looks stale
  (the build stamp can drift after edits), re-locate by component + text.
- **Be conservative.** Fix exactly what's reported. Resist scope creep.
- **Responsiveness:** treat captures at narrow `viewport.width` as responsive bugs; use the
  project's breakpoint system rather than fixed widths.
- Never edit anything under `.nitpick/` except to flip `status`/add `resolution`.
