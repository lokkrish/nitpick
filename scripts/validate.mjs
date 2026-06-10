#!/usr/bin/env node
// Lightweight structural validation for the Nitpick plugin (no external deps).
// Runs in CI; mirrors the essentials of `claude plugin validate`.
import fs from 'node:fs';
import path from 'node:path';

const errors = [];
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
const json = (p) => { try { return JSON.parse(read(p)); } catch (e) { errors.push(`${p}: invalid JSON (${e.message})`); return null; } };

const plugin = json('.claude-plugin/plugin.json');
if (plugin && !plugin.name) errors.push('plugin.json: missing required "name"');

const mp = json('.claude-plugin/marketplace.json');
if (mp) {
  if (!mp.name) errors.push('marketplace.json: missing "name"');
  if (!mp.owner || !mp.owner.name) errors.push('marketplace.json: missing "owner.name"');
  if (!Array.isArray(mp.plugins) || mp.plugins.length === 0) errors.push('marketplace.json: "plugins" must be a non-empty array');
  for (const p of mp.plugins || []) if (!p.name || !p.source) errors.push('marketplace.json: a plugin entry is missing name/source');
}

const must = [
  'commands',
  'skills/resolving-ui-feedback/SKILL.md',
  'agents/nitpick-bmad.md',
  'templates/nitpick/NitpickOverlay.tsx',
  'templates/nitpick/nitpick-source.ts',
  'templates/nitpick/route.ts',
  'templates/nitpick/pages-api-route.ts',
  'templates/bmad/nitpick-skill.md',
];
for (const m of must) if (!exists(m)) errors.push(`missing expected path: ${m}`);

if (exists('commands')) {
  for (const f of fs.readdirSync('commands')) {
    if (!f.endsWith('.md')) continue;
    if (!/^---[\s\S]*?description:/.test(read(path.join('commands', f)))) errors.push(`commands/${f}: missing "description" frontmatter`);
  }
}

if (errors.length) {
  console.error('✗ Nitpick plugin validation failed:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log('✓ Nitpick plugin structure valid');
