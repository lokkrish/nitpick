#!/usr/bin/env node
// Lightweight structural validation for the Nitpick plugin (no external deps).
// Runs in CI; mirrors the essentials of `claude plugin validate`, plus template
// integrity checks that guard invariants the templates must keep.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  'commands/sanity.md',
  'skills/resolving-ui-feedback/SKILL.md',
  'agents/nitpick-bmad.md',
  'templates/nitpick/NitpickOverlay.tsx',
  'templates/nitpick/nitpick-source.ts',
  'templates/nitpick/route.ts',
  'templates/nitpick/pages-api-route.ts',
  'templates/nitpick/sanity.mjs',
  'templates/bmad/nitpick-skill.md',
];
for (const m of must) if (!exists(m)) errors.push(`missing expected path: ${m}`);

if (exists('commands')) {
  for (const f of fs.readdirSync('commands')) {
    if (!f.endsWith('.md')) continue;
    if (!/^---[\s\S]*?description:/.test(read(path.join('commands', f)))) errors.push(`commands/${f}: missing "description" frontmatter`);
  }
}

// ---- template integrity ---------------------------------------------------------------------
// The overlay renders inside arbitrary host CSS, so dimension-critical svgs must be sized with
// inline styles — never width/height presentation attributes, which lose to host resets like
// `svg { max-width: 100%; height: auto }` and collapse the layer to 300×150 (the 0.4.0 bug).
if (exists('templates/nitpick/NitpickOverlay.tsx')) {
  const overlay = read('templates/nitpick/NitpickOverlay.tsx');
  if (/<svg[^>]*\s(width|height)=/.test(overlay)) {
    errors.push('NitpickOverlay.tsx: an <svg> uses width/height presentation attributes — host CSS resets override them; size via inline style (width/height/maxWidth in style={})');
  }
  if ((overlay.match(/maxWidth: 'none'/g) || []).length < 2) {
    errors.push("NitpickOverlay.tsx: expected maxWidth: 'none' on both the marquee and snip-editor svgs (defends against host max-width resets)");
  }
  if (!overlay.includes("process.env.NODE_ENV === 'production'")) errors.push('NitpickOverlay.tsx: missing the production gate (must render null in production)');
  if (!overlay.includes("'/api/nitpick'")) errors.push("NitpickOverlay.tsx: endpoint must stay '/api/nitpick' (the route templates and sanity script depend on it)");
  // Hooks the sanity script drives the overlay through — renaming any of these breaks /nitpick:sanity.
  for (const hook of ['data-nitpick-ui="root"', 'Activate Nitpick', 'alt="snip"', 'strokeDasharray', 'Fix me', "'meta'"]) {
    if (!overlay.includes(hook)) errors.push(`NitpickOverlay.tsx: missing "${hook}" — templates/nitpick/sanity.mjs locates the overlay by it`);
  }
  if (plugin && plugin.version && !overlay.includes(`NITPICK_VERSION = '${plugin.version}'`)) {
    errors.push(`NitpickOverlay.tsx: NITPICK_VERSION must match plugin.json version (${plugin.version}) — it's reported in "Fix me" diagnostics and used for drift detection`);
  }
}
for (const r of ['templates/nitpick/route.ts', 'templates/nitpick/pages-api-route.ts']) {
  if (exists(r) && !read(r).includes("NODE_ENV !== 'production'")) errors.push(`${r}: missing the dev-only NODE_ENV gate`);
}
if (exists('templates/nitpick/sanity.mjs')) {
  try { execFileSync(process.execPath, ['--check', 'templates/nitpick/sanity.mjs'], { stdio: 'pipe' }); }
  catch (e) { errors.push(`templates/nitpick/sanity.mjs: syntax error (node --check failed): ${String(e.stderr || e.message).slice(0, 200)}`); }
}

if (errors.length) {
  console.error('✗ Nitpick plugin validation failed:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log('✓ Nitpick plugin structure valid');
