# Contributing to Nitpick

Thanks for helping make Nitpick better! 📍 Issues, ideas, and PRs are all welcome.

## Repo layout

```
.claude-plugin/        plugin.json (manifest) + marketplace.json (catalog)
commands/              /nitpick:* slash commands (markdown)
skills/                resolving-ui-feedback skill
agents/                nitpick-bmad Claude Code subagent
templates/             code scaffolded into the user's app
  nitpick/             overlay (NitpickOverlay.tsx), source resolver, dev API routes
  bmad/                BMAD-native agent (skill)
docs/                  landing/demo page (index.html)
DESIGN.md              architecture + data contract (read this first)
```

**Read [`DESIGN.md`](./DESIGN.md) before changing the architecture** — it explains the
two-artifacts-plus-bridge model, the data contract, and the design decisions.

## Quick dev loop

The plugin templates are plain TS/React, so the fastest loop is to test against a throwaway
Next.js app:

```shell
# create a sandbox app
npx create-next-app@latest nitpick-sandbox --ts --app --no-tailwind --use-npm --yes
cd nitpick-sandbox && npm i -D html-to-image

# copy the templates in (or run /nitpick:setup with the plugin installed), then:
npx tsc --noEmit        # typecheck the overlay/routes against real React/Next types
npm run build           # confirm it compiles
```

Validate the plugin manifest:

```shell
claude plugin validate . --strict
```

## Guidelines

- **Keep it dev-only & report-only.** The overlay must never run in production or mutate the host
  app. The API route must stay gated to `NODE_ENV !== 'production'`.
- **Memory-safe by construction.** Captures are bounded to a single region (never the whole long
  page), and the overlay must be inert when idle (no timers/listeners/requests while inactive).
- **Match the data contract** in `DESIGN.md`. If you add a field, update the contract, both route
  handlers, and the fix skill.
- **No new runtime dependencies** in the overlay beyond React + an optional `html-to-image`
  dynamic import.
- Keep changes focused; update `CHANGELOG.md` and bump `version` in `plugin.json` for user-facing
  changes.

## Submitting

1. Fork + branch.
2. Make the change; run typecheck + `claude plugin validate . --strict`.
3. Open a PR describing the change and how you tested it (the PR template will prompt you).

By contributing you agree your contributions are licensed under the repo's [MIT License](./LICENSE).
