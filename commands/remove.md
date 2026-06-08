---
description: Remove Nitpick from this Next.js project — reverses /nitpick:setup (deletes the overlay, dev API route, layout mount, and config).
argument-hint: "[--keep-feedback] [--keep-dep]"
---

# Remove Nitpick from this Next.js project

Cleanly reverse what `/nitpick:setup` added, leaving the app exactly as it was before. This
touches only the user's project — it does **not** uninstall the Claude Code plugin (that's a
separate `/plugin uninstall nitpick@nitpick-tools`; mention it at the end).

**Locate things by searching — do not assume default paths**, since setup adapts to each project
(App vs Pages Router, `src/`, JS/TS). Be surgical with edits. Confirm before any delete you
can't trivially undo. Report every file removed/edited at the end.

Flags in `$ARGUMENTS`:
- `--keep-feedback` → do not delete the `.nitpick/` directory (the captured reports/history).
- `--keep-dep` → do not uninstall `html-to-image`.

## Steps

1. **Find the installation.** Search the project for:
   - the overlay folder: a `nitpick/` directory containing `NitpickOverlay.*` and
     `nitpick-source.*` (typically `components/nitpick/` or `src/components/nitpick/`);
   - the API route: `**/api/nitpick/route.{ts,js}` (App Router) or `**/api/nitpick.{ts,js}`
     (Pages Router);
   - the mount: grep the codebase for `NitpickOverlay` to find the layout/_app file(s) that
     import and render it;
   - optional build stamp: `babel-plugin-nitpick.js` and any reference to it in `.babelrc` /
     `babel.config.*`;
   - the `.nitpick/` data directory and its `.gitignore` entry.

   Report what you found. If nothing is found, tell the user Nitpick doesn't appear to be
   installed here and stop.

2. **Remove the overlay + route files.** Delete the `nitpick/` components folder and the
   `api/nitpick` route file/folder.

3. **Un-mount from the layout.** In each file that references `NitpickOverlay`, remove **only**
   the Nitpick lines: the `import NitpickOverlay …` line and the rendered
   `{process.env.NODE_ENV !== 'production' && <NitpickOverlay … />}` line (it may have a
   `hotkey={…}` prop). Preserve all surrounding markup, metadata, providers, and formatting.
   If removing it leaves an empty wrapper fragment that setup added, simplify back to the
   original shape.

4. **Remove the optional build stamp**, if present: delete `babel-plugin-nitpick.js` and remove
   the Nitpick plugin entry from `.babelrc`/`babel.config.*`. If that leaves the Babel config
   empty/equivalent to default (only `next/babel`), offer to delete the file so the project
   returns to the faster SWC compiler.

5. **Drop the gitignore entry.** Remove the `.nitpick/` line from `.gitignore` (leave the rest
   of the file intact).

6. **Delete captured feedback.** Unless `--keep-feedback` was passed, delete the `.nitpick/`
   directory. It holds the user's reports and screenshots — **confirm before deleting** if it
   contains any items, and mention how many.

7. **Uninstall the dependency.** Unless `--keep-dep` was passed, check whether anything else
   imports `html-to-image` (grep). If nothing else uses it, uninstall it with the project's
   package manager (npm/pnpm/yarn/bun, detected from the lockfile): e.g.
   `npm uninstall html-to-image`. If other code uses it, leave it and say so.

8. **Verify & report.** List every file deleted and edited. Tell the user to restart the dev
   server (or rebuild) so the changes take effect, and optionally run a typecheck/build to
   confirm the app is clean. Finally, remind them that to remove the tooling from Claude Code
   itself:

   ```
   /plugin uninstall nitpick@nitpick-tools
   /plugin marketplace remove nitpick-tools   # optional
   ```

Be conservative: never delete or rewrite unrelated files, and when in doubt about whether a
match is Nitpick's, ask before removing it.
