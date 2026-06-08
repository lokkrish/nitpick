---
description: Read the Nitpick feedback queue (.nitpick/) and fix each open UI issue at its source.
argument-hint: "[id]  (optional: fix only this feedback id, e.g. 003)"
---

# Process Nitpick feedback

Work through the visual feedback the user captured with the Nitpick overlay. This is the
agent-side of Nitpick — follow the **resolving-ui-feedback** skill's workflow.

## Do this

1. Read `.nitpick/queue.json` in the project root.
   - If it's missing or has no `open` items, tell the user there's nothing queued and remind
     them to capture issues with **Ctrl+Shift+Q** in their running app. Stop.
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

Be precise and conservative: change what the feedback asks for, verify the file actually
renders that element, and don't refactor unrelated code.
