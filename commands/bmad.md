---
description: Route Nitpick UI feedback into a BMAD-METHOD project — triage into quick-fix (hand to the dev agent) or backlog (turn into stories after an epic).
argument-hint: "[triage | quick-fix <id> | backlog <id> | stories <epic> | status]"
---

# Route Nitpick feedback through BMAD

Bridge captured `.nitpick/` feedback into this project's **BMAD-METHOD** workflow. Use the
**`nitpick-bmad`** agent's approach (see that agent for the full method). Nitpick reports;
BMAD's **dev** agent implements — don't edit app code directly in a BMAD repo unless asked.

Parse `$ARGUMENTS`:

- *(no args)* or `triage` → detect BMAD, then triage every open, untriaged item with the user
  into **quick-fix** or **backlog**, writing the chosen `disposition` back to `.nitpick/<id>.json`
  and `queue.json` (and `epic` if known).
- `quick-fix <id>` → format that item as a dev-ready task (source file/component from
  `element.source`/`selector`/`componentName`, the precise change, and the `<id>.png` path) and
  hand it to the BMAD **dev** agent. Mark resolved with a note once done.
- `backlog <id>` → mark `disposition: "backlog"` (leave open for later).
- `stories <epic>` → an epic is complete: convert that epic's backlog items into BMAD **story
  files**, matching the project's story location + template/format exactly; record each new
  story path in the item's `bmadStory` and mark the item resolved (it now lives as a story).
- `status` → print a table of items → disposition → action/story path.

## Before anything

Detect the BMAD setup and **read its conventions** (don't assume — versions differ):

- **v6** (current): a `_bmad/` dir + skills under `.claude/skills/bmad-*`. Output locations are
  in `_bmad/bmm/config.yaml` (`implementation_artifacts`, `output_folder`). Route quick-fix → the
  `bmad-quick-dev` skill (fallback `bmad-agent-dev`); backlog → `bmad-create-story`. Confirm those
  skill names exist before invoking.
- **v4** (legacy): `.bmad-core/` with `agents/*.md` and `core-config.yaml` (`devStoryLocation`).

Open an existing story (or the create-story skill/template) and match its format exactly. If no
BMAD is found, tell the user and suggest `/nitpick:process` (direct fix) instead.

For the complete triage heuristics, quick-fix handoff, and story-creation rules, follow the
`nitpick-bmad` agent.
