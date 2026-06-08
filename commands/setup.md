---
description: Scaffold the Nitpick visual feedback overlay into this Next.js project (dev-only).
argument-hint: "(run from your Next.js project root)"
---

# Set up Nitpick in this Next.js project

You are installing the **Nitpick** in-app feedback overlay. The reusable source lives in this
plugin at `${CLAUDE_PLUGIN_ROOT}/templates/`. Your job is to copy those templates into the
user's Next.js project, adapting paths/extensions to the project's layout, and wire up a
dev-only mount. **Copy template contents verbatim** — do not rewrite the overlay logic.

Work through these steps, reporting what you find and do. Ask before overwriting any file that
already exists.

## 1. Confirm this is a Next.js project & detect its shape

- Read `package.json`. Confirm `next` is a dependency. If not, stop and tell the user Nitpick
  targets Next.js.
- Detect, by checking which directories exist:
  - **Router:** App Router (`app/` or `src/app/`) vs Pages Router (`pages/` or `src/pages/`).
    Prefer App Router if both exist.
  - **`src/` layout:** are routes under `src/`? Mirror that for new files.
  - **Language:** TypeScript (`tsconfig.json` present, `.tsx` files) vs JavaScript.
  - **Import alias:** read `tsconfig.json`/`jsconfig.json` `compilerOptions.paths` (e.g. is
    `@/*` mapped?). Use the alias for imports when available, else a correct relative path.
- Read the React/Next versions from `package.json` (you'll need them in step 6).

State the detected shape before proceeding.

## 2. Copy the overlay components

Create a `nitpick/` folder under the project's components location (`components/nitpick/` or
`src/components/nitpick/`; create `components/` if the project has no convention) and copy:

- `${CLAUDE_PLUGIN_ROOT}/templates/nitpick/NitpickOverlay.tsx` → `…/components/nitpick/NitpickOverlay.tsx`
- `${CLAUDE_PLUGIN_ROOT}/templates/nitpick/nitpick-source.ts` → `…/components/nitpick/nitpick-source.ts`

**If the project is JavaScript (not TS):** copy to `.jsx`/`.js`, strip the TypeScript type
annotations/interfaces, and keep the runtime logic identical.

## 3. Copy the dev-only API route (the bridge)

- **App Router:** copy `${CLAUDE_PLUGIN_ROOT}/templates/nitpick/route.ts` →
  `app/api/nitpick/route.ts` (or `src/app/api/nitpick/route.ts`).
- **Pages Router:** copy `${CLAUDE_PLUGIN_ROOT}/templates/nitpick/pages-api-route.ts` →
  `pages/api/nitpick.ts` (or `src/pages/api/nitpick.ts`).

This route writes feedback to `.nitpick/` and is hard-gated to development. Keep the exact path
`api/nitpick` — do **not** prefix the folder with an underscore (e.g. `api/_nitpick`): the App
Router treats leading-underscore folders as private and excludes them from routing, so the
endpoint would silently 404. The overlay POSTs to `/api/nitpick`.

## 4. Mount the overlay (dev-only)

- **App Router:** edit the root layout (`app/layout.tsx` or `src/app/layout.tsx`). Add the
  import and render the overlay inside `<body>`, after `{children}`:

  ```tsx
  import NitpickOverlay from '@/components/nitpick/NitpickOverlay'; // adjust to alias/relative

  // …inside <body>:
  {children}
  {process.env.NODE_ENV !== 'production' && <NitpickOverlay />}
  ```

  `NitpickOverlay` is a client component (`'use client'`), so it's fine to render from a
  server layout.

- **Pages Router:** edit `pages/_app.tsx` (create it if absent) and render the overlay next to
  `<Component {...pageProps} />`, wrapped in the same `NODE_ENV` guard, inside a fragment.

Make the minimal edit; preserve existing layout content, metadata, providers, etc.

## 5. Gitignore + dependency

- Append `.nitpick/` to the project's `.gitignore` (create it if missing) unless the user says
  they want feedback committed.
- Install the optional screenshot dependency (best-effort; screenshots degrade gracefully
  without it). Detect the package manager from the lockfile and run the dev-install, e.g.:
  - npm: `npm install -D html-to-image`
  - pnpm: `pnpm add -D html-to-image`
  - yarn: `yarn add -D html-to-image`
  - bun: `bun add -d html-to-image`

## 6. Exact source lines (only if needed)

Nitpick maps clicks to `file:line` automatically via React Fiber on **React ≤ 18 / Next ≤ 14**
with no extra config. If this project is on **React 19 / Next 15+**, the fiber source field is
gone, so clicks resolve to component + selector (still very usable) but not an exact line.

If on React 19+, tell the user this and **offer** the optional build-time stamp for exact
lines, making clear the tradeoff: adding Babel opts the app out of the faster SWC compiler.
Only if they accept:

- Copy `${CLAUDE_PLUGIN_ROOT}/templates/babel-plugin-nitpick.js` into the project (e.g.
  `nitpick/babel-plugin-nitpick.js`).
- Create/extend `.babelrc` with `next/babel` preset + the plugin path (dev). Warn that this
  affects build performance and is easy to revert by deleting `.babelrc`.

Do **not** do this unless the user opts in.

## 7. Report & verify

Summarize every file created/edited. Then tell the user:

1. Run the dev server (`npm run dev` or equivalent).
2. Press **Ctrl+Shift+. (period)**, click an element, annotate, add a comment, Save.
3. Confirm a `.nitpick/001.json` (and `001.png`) appears.
4. Back here, run **`/nitpick:process`** to have me fix the queued issues.

If you can, do a quick sanity check that the dev server compiles after the edits (offer to run
it), but don't block on it.
