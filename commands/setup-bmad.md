---
description: Install the Nitpick agent into this BMAD-METHOD project, adapting to the project's BMAD version (v6 skill or v4 agent).
argument-hint: "(run from the root of a BMAD-METHOD project)"
---

# Install the Nitpick agent into BMAD

Add Nitpick as a first-class BMAD agent so the user can activate it like any other BMAD agent.
**BMAD's format differs by major version**, so detect the version and install the matching
artifact — never copy blindly. The reference skill ships at
`${CLAUDE_PLUGIN_ROOT}/templates/bmad/nitpick-skill.md`.

## 1. Detect BMAD and its version

- **v6** (current): a `_bmad/` directory, agents/workflows exposed as Claude skills under
  `.claude/skills/bmad-*` (and often mirrored in `.agents/skills/`). Confirm the version in
  `_bmad/bmm/config.yaml` (the `Version:` header) or `_bmad/_config/manifest.yaml`.
- **v4** (legacy): a `.bmad-core/` (or `bmad-core/`) directory with `agents/*.md` and
  `core-config.yaml`.
- If neither is found, stop — tell the user this is for BMAD projects (they can still use
  `/nitpick:bmad`).

State the detected version and layout before installing.

## 2a. Install on BMAD v6 (skill)

1. **Learn the format**: open an existing skill (e.g. `.claude/skills/bmad-create-story/SKILL.md`)
   and note its frontmatter shape and section conventions.
2. **Write the skill** to `.claude/skills/bmad-nitpick/SKILL.md`, using the content from
   `${CLAUDE_PLUGIN_ROOT}/templates/bmad/nitpick-skill.md` and reconciling its structure to match
   the project's existing skills. If the project mirrors skills into `.agents/skills/` (check),
   copy it there too so both IDE targets see it.
3. **Verify routing targets exist** in this install: `bmad-quick-dev` (quick-fix),
   `bmad-create-story` / `bmad-create-epics-and-stories` (backlog → stories), and `bmad-agent-dev`
   (the dev agent). If a name differs, update the skill's command bodies to the actual names.
4. Read output locations from `_bmad/bmm/config.yaml` (`implementation_artifacts`,
   `output_folder`) and confirm the skill references those rather than hardcoded paths.

## 2b. Install on BMAD v4 (agent file)

1. Open an existing agent in `<bmad-dir>/agents/` (e.g. `dev.md`) to learn the YAML/persona
   format and how agents are registered (often `.claude/commands/**/agents/*.md`).
2. Author `<bmad-dir>/agents/nitpick.md` in that exact format, with commands `*triage`,
   `*quick-fix {id}`, `*backlog {id}`, `*stories {epic}`, `*status`, mapping to the dev agent and
   story task this v4 install uses. Don't reference task files that don't exist.
3. Register it the same way other agents are registered (mirror an existing command file).

## 3. Verify & report

List what you created. Tell the user how to activate Nitpick the same way they activate other
BMAD agents (for v6, the `bmad-nitpick` skill; e.g. "triage nitpick"). Note that captured
feedback still comes from the overlay (`/nitpick:setup` + Ctrl+Shift+. / double-tap Shift) — this
only adds the BMAD-side agent. The agent maps to the same `.nitpick/` flow as `/nitpick:bmad`.

Be conservative: read before writing, match existing conventions exactly (a malformed
skill/agent won't load), confirm before overwriting, and never modify unrelated BMAD files.
