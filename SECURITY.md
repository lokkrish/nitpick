# Security Policy

## Scope & design

Nitpick is a **development-time** tool. By design:

- The overlay renders **only** when `NODE_ENV !== 'production'`.
- The scaffolded API route **refuses to run in production** (returns `410`) and only ever writes
  under `.nitpick/` in the project root.
- The overlay **reports only** — it never executes app code paths or sends data anywhere except
  your own dev server.

Because the route writes files based on requests, **keep it dev-only** (the default). Do not
expose a dev server with the Nitpick route to untrusted networks.

## Reporting a vulnerability

If you find a security issue, please **do not open a public issue**. Email
**lokeshwaran2491@gmail.com** with details and steps to reproduce. We'll acknowledge within a few
days and work with you on a fix and disclosure timeline.

Thank you for helping keep Nitpick and its users safe.
