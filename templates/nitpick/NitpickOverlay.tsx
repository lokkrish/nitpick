'use client';

/**
 * Nitpick — in-app visual feedback overlay (dev-only). v2.5.
 *
 * Activate (Ctrl+Shift+. / double-tap Shift / click the badge) → a draggable toolbox appears
 * with NOTHING selected. Tools:
 *   • Inspect  — click element(s) to capture each one's React source + Playwright-style locators
 *                AND a cropped screenshot of that element (saved as <id>-1.png, <id>-2.png, … for
 *                the 1st, 2nd, … element). Stays active for multi-select.
 *   • Snip     — drag a region; we capture exactly that region (at any scroll position), then you
 *                mark it up on the cropped image (Arrow / Line / Circle / Box / Pen / Text). Saved
 *                as a flat image + comment (markup baked into the image — no coordinates stored).
 *   • Record   — hide the overlay and log clicks / inputs / dropdowns / radios / navigation in
 *                the background, across screens. Records the ACTION FLOW only (no screenshots).
 *   • Fix me   — report a problem with Nitpick ITSELF. Saved as captureType "meta" with the
 *                Nitpick UI visible in the screenshot + tool diagnostics, so the user's agent
 *                fixes the tool rather than the app. Comment can be typed or dictated (Web
 *                Speech, where the browser supports it).
 * Add a comment / reference image, then Save → POST to /api/nitpick → `.nitpick/`.
 *
 * Self-contained: only React + ./nitpick-source. Screenshots are best-effort via an optional
 * dynamic import of `html-to-image` (with a timeout so Save never hangs).
 * Report-only: nothing here mutates the host app; in production the component renders null.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveElementInfo, type ElementInfo } from './nitpick-source';

const ACCENT = '#ff2d55';
const Z = 2147483600;
const ENDPOINT = '/api/nitpick';
const NITPICK_VERSION = '0.4.1'; // keep in sync with plugin.json (CI checks this)

// ----------------------------------------------------------------- hotkey

export interface Hotkey { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean; code: string }
const DEFAULT_HOTKEY: Hotkey = { ctrl: true, shift: true, code: 'Period' };
function matchHotkey(e: KeyboardEvent, h: Hotkey): boolean {
  return e.code === h.code && e.ctrlKey === !!h.ctrl && e.metaKey === !!h.meta && e.altKey === !!h.alt && e.shiftKey === !!h.shift;
}
function hotkeyLabel(h: Hotkey): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');
  const key = h.code.startsWith('Key') ? h.code.slice(3)
    : h.code.startsWith('Digit') ? h.code.slice(5)
      : ({ Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Backquote: '`', Quote: "'" } as Record<string, string>)[h.code] || h.code;
  const parts: string[] = [];
  if (h.ctrl) parts.push('Ctrl');
  if (h.meta) parts.push(isMac ? 'Cmd' : 'Win');
  if (h.alt) parts.push(isMac ? 'Option' : 'Alt');
  if (h.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

// ----------------------------------------------------------------- types

type DrawTool = 'arrow' | 'line' | 'circle' | 'box' | 'pen' | 'text';
type Tool = null | 'inspect' | 'snip';

type Shape =
  | { type: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'pen'; pts: [number, number][] }
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { type: 'text'; x: number; y: number; text: string };

interface Box { x: number; y: number; w: number; h: number }
interface Snip { url: string; w: number; h: number; scale: number; box: Box }
interface Pt { x: number; y: number }

interface Locators { role: string | null; name: string; testId: { attr: string; value: string } | null; getBy: string | null; css: string; xpath: string; outerTag: string }
interface Target {
  source: ElementInfo['source']; componentName: string | null; componentStack: string[];
  tag: string; id: string; classes: string[]; text: string; dataAttributes: Record<string, string>;
  locators: Locators; boundingBox: Box; computedStyles: Record<string, string>;
}
interface Action { type: 'click' | 'input' | 'submit' | 'navigate'; at: string; url: string; locator?: Locators; tag?: string; text?: string; value?: string }

// ----------------------------------------------------------------- DOM helpers

const STYLE_KEYS = [
  'display', 'position', 'width', 'height', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderRadius', 'borderTopWidth',
  'borderColor', 'boxShadow', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily',
  'lineHeight', 'letterSpacing', 'textAlign', 'flexDirection', 'justifyContent', 'alignItems', 'gap',
  'gridTemplateColumns', 'zIndex', 'opacity', 'overflow', 'transform',
];
const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
function getStyleSubset(el: Element): Record<string, string> {
  const cs = getComputedStyle(el); const out: Record<string, string> = {};
  for (const k of STYLE_KEYS) { const v = cs.getPropertyValue(kebab(k)); if (v && v.trim() !== '') out[k] = v.trim(); }
  return out;
}
function buildSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = []; let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
    if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    let part = node.tagName.toLowerCase(); const parent: Element | null = node.parentElement;
    if (parent) { const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName); if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`; }
    parts.unshift(part); node = node.parentElement;
  }
  return parts.join(' > ');
}
function xpathOf(el: Element): string {
  if (el.id) return `//*[@id=${JSON.stringify(el.id)}]`;
  const parts: string[] = []; let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.body) {
    let i = 1; let sib = node.previousElementSibling;
    while (sib) { if (sib.tagName === node.tagName) i++; sib = sib.previousElementSibling; }
    parts.unshift(`${node.tagName.toLowerCase()}[${i}]`); node = node.parentElement;
  }
  return '/html/body/' + parts.join('/');
}
const INPUT_ROLE: Record<string, string | null> = {
  checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button',
  reset: 'button', search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox', number: 'spinbutton', text: 'textbox', password: null,
};
const TAG_ROLE: Record<string, string> = {
  button: 'button', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', ul: 'list', ol: 'list',
  li: 'listitem', table: 'table', select: 'combobox', textarea: 'textbox', form: 'form', section: 'region', dialog: 'dialog',
};
function implicitRole(el: Element): string | null {
  const explicit = el.getAttribute('role'); if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
  if (tag === 'img') return el.getAttribute('alt') === '' ? 'presentation' : 'img';
  if (tag === 'input') return INPUT_ROLE[(el.getAttribute('type') || 'text').toLowerCase()] ?? 'textbox';
  return TAG_ROLE[tag] || null;
}
function accessibleName(el: Element): string {
  const al = el.getAttribute('aria-label'); if (al && al.trim()) return al.trim();
  const lb = el.getAttribute('aria-labelledby');
  if (lb) { const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim(); if (t) return t.replace(/\s+/g, ' '); }
  if (el.tagName === 'IMG') { const alt = el.getAttribute('alt'); if (alt && alt.trim()) return alt.trim(); }
  const id = (el as HTMLElement).id;
  if (id) { const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (lab?.textContent?.trim()) return lab.textContent.trim().replace(/\s+/g, ' '); }
  const txt = (el.textContent || '').trim().replace(/\s+/g, ' '); if (txt) return txt.slice(0, 80);
  const ph = el.getAttribute('placeholder'); if (ph?.trim()) return ph.trim();
  const title = el.getAttribute('title'); if (title?.trim()) return title.trim();
  return '';
}
function testIdOf(el: Element): { attr: string; value: string } | null {
  for (const a of ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa']) { const v = el.getAttribute(a); if (v) return { attr: a, value: v }; }
  return null;
}
function buildLocators(el: Element): Locators {
  const role = implicitRole(el); const name = accessibleName(el); const testId = testIdOf(el);
  let getBy: string | null = null;
  if (role) getBy = `getByRole('${role}'${name ? `, { name: ${JSON.stringify(name.slice(0, 60))} }` : ''})`;
  else if (testId) getBy = `getByTestId(${JSON.stringify(testId.value)})`;
  else if (name) getBy = `getByText(${JSON.stringify(name.slice(0, 60))})`;
  const outerTag = (el.cloneNode(false) as Element).outerHTML.slice(0, 200);
  return { role, name, testId, getBy, css: buildSelector(el), xpath: xpathOf(el), outerTag };
}
function captureTarget(el: Element): Target {
  const info = resolveElementInfo(el); const r = el.getBoundingClientRect();
  const dataAttributes: Record<string, string> = {}; const ds = (el as HTMLElement).dataset || {};
  for (const k of Object.keys(ds)) { if (!k.startsWith('nitpick')) dataAttributes[k] = ds[k] as string; }
  return {
    source: info.source, componentName: info.componentName, componentStack: info.componentStack,
    tag: el.tagName.toLowerCase(), id: (el as HTMLElement).id || '', classes: Array.from(el.classList || []),
    text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140), dataAttributes, locators: buildLocators(el),
    boundingBox: { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) },
    computedStyles: getStyleSubset(el),
  };
}
function interactiveAncestor(el: Element): Element {
  return el.closest('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input, select, textarea, summary, label, [onclick]') || el;
}
function rectShape(s: Pt, p: Pt): Shape {
  return { type: 'rect', x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
}
function snipShape(tool: DrawTool, s: Pt, p: Pt): Shape {
  if (tool === 'arrow') return { type: 'arrow', x1: s.x, y1: s.y, x2: p.x, y2: p.y };
  if (tool === 'line') return { type: 'line', x1: s.x, y1: s.y, x2: p.x, y2: p.y };
  if (tool === 'circle') return { type: 'ellipse', cx: (s.x + p.x) / 2, cy: (s.y + p.y) / 2, rx: Math.abs(p.x - s.x) / 2, ry: Math.abs(p.y - s.y) / 2 };
  return rectShape(s, p); // box
}
// Text size tied to stroke width so it scales with the snip the same way in the live SVG
// preview (renderSnipShape) and the baked canvas (drawShapes).
const textSize = (sw: number) => sw * 5;

// ----------------------------------------------------------------- screenshot

const nitpickFilter = (n: any) => !(n && n.dataset && n.dataset.nitpickUi);
// For "Fix me" (meta) reports the Nitpick UI is the subject, so it stays IN the shot — only the
// transient "Capturing…" curtain is excluded, since it would cover the whole capture.
const capturingFilter = (n: any) => !(n && n.dataset && 'nitpickCapturing' in n.dataset);

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = src; });
}
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);
}
function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[], dpr: number, ox: number, oy: number, lw?: number) {
  ctx.strokeStyle = ACCENT; ctx.fillStyle = ACCENT; ctx.lineWidth = lw ?? Math.max(2, 2.5 * dpr); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const X = (x: number) => (x - ox) * dpr; const Y = (y: number) => (y - oy) * dpr;
  for (const s of shapes) {
    ctx.beginPath();
    if (s.type === 'rect') ctx.strokeRect(X(s.x), Y(s.y), s.w * dpr, s.h * dpr);
    else if (s.type === 'ellipse') { ctx.ellipse(X(s.cx), Y(s.cy), Math.abs(s.rx) * dpr, Math.abs(s.ry) * dpr, 0, 0, Math.PI * 2); ctx.stroke(); }
    else if (s.type === 'line') { ctx.moveTo(X(s.x1), Y(s.y1)); ctx.lineTo(X(s.x2), Y(s.y2)); ctx.stroke(); }
    else if (s.type === 'pen') { s.pts.forEach(([px, py], i) => (i ? ctx.lineTo(X(px), Y(py)) : ctx.moveTo(X(px), Y(py)))); ctx.stroke(); }
    else if (s.type === 'text') {
      const fs = textSize(ctx.lineWidth);
      ctx.font = `700 ${fs}px ui-sans-serif, system-ui, sans-serif`; ctx.textBaseline = 'top';
      s.text.split('\n').forEach((line, i) => ctx.fillText(line, X(s.x), Y(s.y) + i * fs * 1.25));
    }
    else if (s.type === 'arrow') {
      ctx.moveTo(X(s.x1), Y(s.y1)); ctx.lineTo(X(s.x2), Y(s.y2)); ctx.stroke();
      const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1); const head = ctx.lineWidth * 4;
      ctx.beginPath(); ctx.moveTo(X(s.x2), Y(s.y2));
      ctx.lineTo(X(s.x2) - head * Math.cos(ang - Math.PI / 6), Y(s.y2) - head * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(X(s.x2) - head * Math.cos(ang + Math.PI / 6), Y(s.y2) - head * Math.sin(ang + Math.PI / 6));
      ctx.closePath(); ctx.fill();
    }
  }
}
function pageBackground(): string {
  try {
    for (const el of [document.body, document.documentElement]) {
      const c = el && getComputedStyle(el).backgroundColor;
      if (c && !/^rgba?\(0,\s*0,\s*0,\s*0\)$|transparent/.test(c)) return c;
    }
  } catch { /* ignore */ }
  return '#ffffff';
}
// Capture an arbitrary PAGE-coordinate region as a PNG — correct at ANY scroll position, even
// for a region that is entirely off-screen. We render the WHOLE document once at its full
// scroll size and crop the region out of that image on a canvas ourselves.
//
// Two earlier approaches both failed, so don't reintroduce them:
//  • toPng(documentElement) with no size → html-to-image clips to one viewport height (only the
//    top of the page ever captured — the v0.3.2 bug).
//  • a region-sized frame + transform: translate(-x,-y) on the cloned root → modern Chromium
//    IGNORES transforms on the root element when rasterizing SVG-image documents, so the page
//    reflowed into the small frame and snips came out blank (light pages) or black (dark pages).
//    Negative margins on the root are ignored the same way.
// Rendering with explicit full dimensions + canvas cropping uses no root transforms at all and
// works across browsers and frameworks. The pixel ratio is budgeted against the full page size
// so the intermediate canvas always stays within browser limits.
const MAX_CANVAS_AREA = 100_000_000; // px² — well under Chrome's ~268M canvas-area limit
const MAX_CANVAS_DIM = 16000;        // px — under the 16384 per-dimension limit

interface FullRender { img: HTMLImageElement; pr: number }
async function renderDocument(includeUi = false): Promise<FullRender | null> {
  const mod: any = await import('html-to-image').catch(() => null);
  if (!mod || !mod.toPng) return null;
  const doc = document.documentElement;
  const fw = Math.max(doc.scrollWidth, doc.clientWidth);
  const fh = Math.max(doc.scrollHeight, doc.clientHeight);
  let pr = Math.min(window.devicePixelRatio || 1, 2);
  while (pr > 0.5 && (fw * pr * fh * pr > MAX_CANVAS_AREA || fw * pr > MAX_CANVAS_DIM || fh * pr > MAX_CANVAS_DIM)) pr /= 2;
  try {
    const url: string = await mod.toPng(doc, {
      width: fw, height: fh, pixelRatio: pr, cacheBust: true, backgroundColor: pageBackground(),
      filter: includeUi ? capturingFilter : nitpickFilter,
      style: { margin: '0' },
    });
    return { img: await loadImg(url), pr };
  } catch { return null; }
}
function cropFrom(full: FullRender, box: Box): { url: string; pr: number } | null {
  try {
    const { img, pr } = full;
    const w = Math.max(1, Math.round(box.w * pr)); const h = Math.max(1, Math.round(box.h * pr));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'); if (!ctx) return null;
    ctx.fillStyle = pageBackground(); ctx.fillRect(0, 0, w, h); // regions past the page edge stay page-colored
    ctx.drawImage(img, Math.round(box.x * pr), Math.round(box.y * pr), w, h, 0, 0, w, h);
    return { url: canvas.toDataURL('image/png'), pr };
  } catch { return null; }
}
async function captureRegion(box: Box, includeUi = false): Promise<{ url: string; pr: number } | null> {
  const full = await renderDocument(includeUi);
  return full ? cropFrom(full, box) : null;
}
// Capture exactly the viewport the user is looking at (a context shot for comment-only reports).
async function captureViewport(includeUi = false): Promise<string | null> {
  const cap = await captureRegion({ x: window.scrollX, y: window.scrollY, w: window.innerWidth, h: window.innerHeight }, includeUi);
  return cap ? cap.url : null;
}
// One cropped screenshot per Inspected element (a little padding for context). Saved as
// <id>-1.png, <id>-2.png, … aligned with `targets`. The document is rendered ONCE and every
// element is cropped from the same image.
async function captureElementImages(targets: Target[]): Promise<(string | null)[]> {
  const full = await renderDocument(); const pad = 8;
  return targets.slice(0, 20).map((t) => {
    if (!full) return null;
    const bb = t.boundingBox;
    const cap = cropFrom(full, { x: Math.max(0, bb.x - pad), y: Math.max(0, bb.y - pad), w: Math.max(1, bb.w + pad * 2), h: Math.max(1, bb.h + pad * 2) });
    return cap ? cap.url : null;
  });
}
// Bake the snip-editor drawings into the cropped image (image-local coords, scale 1).
async function flattenSnip(url: string, shapes: Shape[]): Promise<string> {
  try {
    const img = await loadImg(url);
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); if (!ctx) return url;
    ctx.drawImage(img, 0, 0);
    if (shapes.length) drawShapes(ctx, shapes, 1, 0, 0, Math.max(3, Math.round(img.width * 0.004)));
    return canvas.toDataURL('image/png');
  } catch { return url; }
}

// ----------------------------------------------------------------- component

export default function NitpickOverlay({ hotkey }: { hotkey?: Hotkey } = {}) {
  if (process.env.NODE_ENV === 'production') return null;
  return <NitpickOverlayInner hotkey={hotkey ?? DEFAULT_HOTKEY} />;
}

function NitpickOverlayInner({ hotkey }: { hotkey: Hotkey }) {
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [tool, setTool] = useState<Tool>(null);
  const [metaMode, setMetaMode] = useState(false); // "Fix me" — the report is about Nitpick itself
  const [listening, setListening] = useState(false); // dictation (Web Speech, when available)
  const [drawTool, setDrawTool] = useState<DrawTool>('arrow'); // active sub-tool inside the Snip editor
  const [marquee, setMarquee] = useState<Shape | null>(null);  // in-progress snip selection (page coords)
  const [targets, setTargets] = useState<Target[]>([]);
  const [snip, setSnip] = useState<Snip | null>(null); // snip editor open when set
  const [snipShapes, setSnipShapes] = useState<Shape[]>([]); // baked into image, never persisted as coords
  const [snipDraft, setSnipDraft] = useState<Shape | null>(null);
  const [snipText, setSnipText] = useState<{ x: number; y: number; value: string } | null>(null); // open text box (image-local coords)
  const [capturing, setCapturing] = useState(false); // a screenshot is in flight
  const [actions, setActions] = useState<Action[]>([]);
  const [hovered, setHovered] = useState<DOMRect | null>(null);
  const [comment, setComment] = useState('');
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [pos, setPos] = useState({ x: 24, y: 16 });

  const drawStart = useRef<Pt | null>(null);
  const snipStart = useRef<Pt | null>(null);
  const snipTextRef = useRef<typeof snipText>(null); // mirror for the global Escape handler
  snipTextRef.current = snipText;
  const dragOff = useRef<Pt | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUrlRef = useRef('');
  const recogRef = useRef<any>(null);

  const showToast = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const stopMic = useCallback(() => {
    try { recogRef.current?.stop(); } catch { /* ignore */ }
    recogRef.current = null; setListening(false);
  }, []);

  const close = useCallback(() => {
    setActive(false); setRecording(false); setTool(null); setMetaMode(false); setMarquee(null);
    setTargets([]); setSnip(null); setSnipShapes([]); setSnipDraft(null); setSnipText(null);
    setCapturing(false); setActions([]); setHovered(null); setComment(''); setReferenceImage(null); setSubmitting(false);
    drawStart.current = null; snipStart.current = null; stopMic();
  }, [stopMic]);

  const openTools = useCallback(() => {
    setActive(true); setRecording(false); setTool(null); setMetaMode(false); setSubmitting(false);
    setActions([]); setTargets([]); setSnip(null); setSnipShapes([]); setMarquee(null);
    if (typeof window !== 'undefined') { setScroll({ x: window.scrollX, y: window.scrollY }); setPos({ x: Math.max(8, (window.innerWidth - 480) / 2), y: 14 }); }
  }, []);

  // mount — start clean. The overlay holds nothing across page loads; it is completely inert
  // unless you actively use it.
  useEffect(() => {
    setMounted(true);
    // eslint-disable-next-line no-console
    console.info(`[Nitpick] ready — ${hotkeyLabel(hotkey)} / double-tap Shift / click the badge.`);
  }, [hotkey]);

  // activation
  useEffect(() => {
    let lastShift = 0;
    const toggle = () => (active ? close() : openTools());
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchHotkey(e, hotkey)) { e.preventDefault(); toggle(); return; }
      if (e.key === 'Escape' && active) {
        e.preventDefault();
        if (recording) setRecording(false);
        else if (snip && snipTextRef.current) setSnipText(null); // just dismiss the open text box
        else if (snip) { setSnip(null); setSnipShapes([]); setSnipDraft(null); setSnipText(null); }
        else close();
        return;
      }
      if (e.key !== 'Shift') lastShift = 0;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return;
      const n = Date.now();
      if (n - lastShift > 40 && n - lastShift < 450) { lastShift = 0; if (!active) openTools(); } else lastShift = n;
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => { window.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('keyup', onKeyUp, true); };
  }, [active, recording, snip, hotkey, close, openTools]);

  // keep the selection/highlight layer aligned while scrolling
  useEffect(() => {
    if (!active || recording || snip) return;
    const onScroll = () => setScroll({ x: window.scrollX, y: window.scrollY });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [active, recording, snip]);

  // Inspect — hover highlight + click to capture; excludes Nitpick UI so the comment box works
  useEffect(() => {
    if (!active || recording || snip || tool !== 'inspect') { setHovered(null); return; }
    const onUi = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-nitpick-ui]');
    const under = (x: number, y: number): Element | null => {
      const el = document.elementFromPoint(x, y);
      if (!el || onUi(el) || el === document.documentElement || el === document.body) return null;
      return el;
    };
    const onMove = (e: MouseEvent) => { if (onUi(e.target)) return; const el = under(e.clientX, e.clientY); setHovered(el ? el.getBoundingClientRect() : null); };
    const onClick = (e: MouseEvent) => { if (onUi(e.target)) return; const el = under(e.clientX, e.clientY); if (!el) return; e.preventDefault(); e.stopPropagation(); setTargets((t) => [...t, captureTarget(el)]); };
    const block = (e: Event) => { if (onUi(e.target)) return; e.preventDefault(); e.stopPropagation(); };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('mousedown', block, true);
    window.addEventListener('mouseup', block, true);
    return () => {
      window.removeEventListener('mousemove', onMove, true); window.removeEventListener('click', onClick, true);
      window.removeEventListener('mousedown', block, true); window.removeEventListener('mouseup', block, true);
    };
  }, [active, recording, snip, tool]);

  // Record — overlay hidden; capture clicks / inputs (text, select, radio, checkbox) / submit /
  // navigation as an ACTION FLOW (no screenshots). Survives client-side navigation (the component
  // stays mounted), so a flow can span multiple screens.
  useEffect(() => {
    if (!active || !recording) return;
    const onUi = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-nitpick-ui]');
    const record = (a: Omit<Action, 'at' | 'url'>) =>
      setActions((prev) => [...prev, { ...a, at: new Date().toISOString(), url: location.pathname + location.search }]);
    lastUrlRef.current = location.pathname + location.search;
    record({ type: 'navigate' });
    const onClick = (e: MouseEvent) => {
      if (onUi(e.target) || !(e.target instanceof Element)) return;
      const el = interactiveAncestor(e.target);
      record({ type: 'click', locator: buildLocators(el), tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) });
    };
    const onChange = (e: Event) => {
      const t = e.target; if (onUi(t)) return;
      if (t instanceof HTMLSelectElement) { const opt = t.options[t.selectedIndex]; record({ type: 'input', locator: buildLocators(t), value: `select → ${opt ? opt.text.trim() : t.value}` }); return; }
      if (t instanceof HTMLInputElement) {
        const ty = t.type;
        if (ty === 'checkbox' || ty === 'radio') { record({ type: 'input', locator: buildLocators(t), value: `${ty} ${t.checked ? 'checked' : 'unchecked'}${t.value && t.value !== 'on' ? ` (${t.value})` : ''}` }); return; }
        record({ type: 'input', locator: buildLocators(t), value: ty === 'password' ? '***' : String(t.value).slice(0, 120) }); return;
      }
      if (t instanceof HTMLTextAreaElement) { record({ type: 'input', locator: buildLocators(t), value: String(t.value).slice(0, 120) }); }
    };
    const onSubmit = (e: Event) => { if (!onUi(e.target) && e.target instanceof Element) record({ type: 'submit', locator: buildLocators(e.target) }); };
    // Next calls history.pushState/replaceState from inside a React insertion effect (where
    // scheduling updates is disallowed) and fires replaceState often (scroll/param syncs). Defer
    // out of that call stack, and only record a REAL screen change (dedupe same-URL calls).
    const onNav = () => {
      setTimeout(() => {
        const url = location.pathname + location.search;
        if (url === lastUrlRef.current) return;
        lastUrlRef.current = url;
        record({ type: 'navigate' });
      }, 0);
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('submit', onSubmit, true);
    window.addEventListener('popstate', onNav);
    const origPush = history.pushState; const origReplace = history.replaceState;
    history.pushState = function (this: History, ...args: any[]) { const r = origPush.apply(this, args as any); onNav(); return r; } as typeof history.pushState;
    history.replaceState = function (this: History, ...args: any[]) { const r = origReplace.apply(this, args as any); onNav(); return r; } as typeof history.replaceState;
    return () => {
      document.removeEventListener('click', onClick, true); document.removeEventListener('change', onChange, true);
      document.removeEventListener('submit', onSubmit, true); window.removeEventListener('popstate', onNav);
      history.pushState = origPush; history.replaceState = origReplace;
    };
  }, [active, recording]);

  useEffect(() => {
    if (!active || recording) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items; if (!items) return;
      for (const it of Array.from(items)) { if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) { readImage(f); e.preventDefault(); } } }
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, [active, recording]);

  const readImage = useCallback((file: File) => {
    const r = new FileReader(); r.onload = () => setReferenceImage(typeof r.result === 'string' ? r.result : null); r.readAsDataURL(file);
  }, []);

  // ----- snip marquee (page coords) -----
  const pagePt = (e: React.PointerEvent): Pt => ({ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY });
  const onPageDown = (e: React.PointerEvent) => {
    if (tool !== 'snip') return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = pagePt(e); drawStart.current = p; setMarquee(rectShape(p, p));
  };
  const onPageMove = (e: React.PointerEvent) => {
    const s = drawStart.current; if (!s) return; setMarquee(rectShape(s, pagePt(e)));
  };
  const onPageUp = async () => {
    const m = marquee; drawStart.current = null; setMarquee(null);
    if (!m || m.type !== 'rect' || m.w <= 6 || m.h <= 6) return;
    const box = { x: m.x, y: m.y, w: m.w, h: m.h };
    setCapturing(true);
    const cap = await withTimeout(captureRegion(box), 15000, null);
    setCapturing(false);
    if (cap) {
      const img = await loadImg(cap.url);
      const scale = Math.min(Math.min(window.innerWidth * 0.8, 900) / img.width, (window.innerHeight * 0.65) / img.height, 1);
      setSnip({ url: cap.url, w: img.width, h: img.height, scale, box }); setSnipShapes([]); setDrawTool('arrow');
    } else showToast('Snip failed (html-to-image)');
  };

  // ----- snip-editor drawing (image-local coords, baked into the image — no stored coords) -----
  const snipPt = (e: React.PointerEvent): Pt => {
    const r = (e.currentTarget as Element).getBoundingClientRect(); const sc = snip ? snip.scale : 1;
    return { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
  };
  const commitSnipText = () => {
    const t = snipText; setSnipText(null);
    if (t && t.value.trim()) setSnipShapes((a) => [...a, { type: 'text', x: t.x, y: t.y, text: t.value.trim() }]);
  };
  const onSnipDown = (e: React.PointerEvent) => {
    if (drawTool === 'text') {
      // an open text box commits via its blur (fired by this same press) — only place a new one if none is open
      if (!snipText) setSnipText({ ...snipPt(e), value: '' });
      return;
    }
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = snipPt(e); snipStart.current = p;
    setSnipDraft(drawTool === 'pen' ? { type: 'pen', pts: [[p.x, p.y]] } : snipShape(drawTool, p, p));
  };
  const onSnipMove = (e: React.PointerEvent) => {
    const s = snipStart.current; if (!s) return; const p = snipPt(e);
    if (drawTool === 'pen') setSnipDraft((d) => (d && d.type === 'pen' ? { type: 'pen', pts: [...d.pts, [p.x, p.y]] } : d));
    else setSnipDraft(snipShape(drawTool, s, p));
  };
  const onSnipUp = () => { const d = snipDraft; snipStart.current = null; setSnipDraft(null); if (d) setSnipShapes((a) => [...a, d]); };

  const undo = () => {
    if (snip) return setSnipShapes((a) => a.slice(0, -1));
    if (targets.length) return setTargets((t) => t.slice(0, -1));
    if (actions.length) return setActions((a) => a.slice(0, -1));
  };

  const pickTool = (t: Tool) => { setMetaMode(false); setTool((cur) => (cur === t ? null : t)); };

  // "Fix me" — dictate or type what's wrong with Nitpick itself. Web Speech is feature-detected;
  // the mic button only renders where the API exists (Chrome/Edge). Transcripts append to the
  // comment so dictation and typing mix freely.
  const SpeechRec: any = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
  const toggleMic = () => {
    if (listening) { stopMic(); return; }
    try {
      const rec = new SpeechRec();
      rec.continuous = true; rec.interimResults = false; rec.lang = navigator.language || 'en-US';
      rec.onresult = (e: any) => {
        let text = '';
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript;
        if (text.trim()) setComment((c) => (c ? c.replace(/\s+$/, '') + ' ' : '') + text.trim());
      };
      rec.onend = () => setListening(false);
      rec.onerror = () => setListening(false);
      recogRef.current = rec; rec.start(); setListening(true);
    } catch { stopMic(); }
  };

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true); setCapturing(true);
    try {
      const isMeta = metaMode; // "Fix me" — the report is about Nitpick itself, not the app
      const isSnip = !isMeta && !!snip;
      const liveActions = isMeta ? [] : actions;
      const isRecording = !isSnip && liveActions.length > 0;
      const reportTargets = isSnip || isMeta ? [] : targets;
      let screenshot: string | null = null;
      let targetImages: (string | null)[] = [];
      if (isMeta) screenshot = await withTimeout(captureViewport(true), 12000, null); // WITH the Nitpick UI — it's the subject
      else if (isSnip && snip) screenshot = await withTimeout(flattenSnip(snip.url, snipShapes), 8000, snip.url);
      else if (reportTargets.length) targetImages = await withTimeout(captureElementImages(reportTargets), 15000, []);
      else if (!isRecording) screenshot = await withTimeout(captureViewport(), 12000, null);
      // recording → action flow only, no screenshot
      const payload = {
        comment,
        route: window.location.pathname + window.location.search,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1, scrollX: window.scrollX, scrollY: window.scrollY },
        captureType: isMeta ? 'meta' : isSnip ? 'snip' : isRecording ? 'recording' : reportTargets.length ? 'element' : 'full',
        coordSpace: isSnip ? null : 'page',
        annotations: [], // snip drawings are baked into the image; no page-level vector annotations
        targets: reportTargets,
        targetImages, // one cropped screenshot per target → server saves <id>-1.png, <id>-2.png, …
        element: reportTargets[0] ?? null,
        actions: liveActions,
        screenshot, referenceImage,
        // diagnostics for fixing the tool (only on meta reports; older routes drop this field harmlessly)
        meta: isMeta ? { tool: 'nitpick', version: NITPICK_VERSION, userAgent: navigator.userAgent, hotkey: hotkeyLabel(hotkey) } : null,
      };
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { showToast(`📍 Saved feedback #${data.id ?? ''}`); close(); }
      else showToast(`Save failed (${res.status})`);
    } catch { showToast('Save failed — is the dev server running?'); } finally { setSubmitting(false); setCapturing(false); }
  }, [submitting, metaMode, snip, snipShapes, comment, targets, actions, referenceImage, hotkey, close, showToast]);

  if (!mounted) return null;

  const snipMarqueeActive = active && !recording && !snip && tool === 'snip';
  const snipSw = snip ? Math.max(2, snip.w * 0.004) : 3;

  const content = (
    <div data-nitpick-ui="root" style={{ position: 'fixed', inset: 0, zIndex: Z, pointerEvents: 'none', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      {/* IDLE badge */}
      {!active && (
        <button data-nitpick-ui onClick={openTools} title={`Activate Nitpick — ${hotkeyLabel(hotkey)} or double-tap Shift`}
          style={{ position: 'fixed', bottom: 12, right: 12, padding: '7px 11px', borderRadius: 8, fontSize: 11, color: '#fff', background: 'rgba(20,20,22,0.82)', boxShadow: '0 2px 10px rgba(0,0,0,0.3)', border: 'none', cursor: 'pointer', pointerEvents: 'auto', fontFamily: 'inherit' }}>
          📍 Nitpick · <b>{hotkeyLabel(hotkey)}</b>
        </button>
      )}

      {/* RECORDING indicator */}
      {active && recording && (
        <div data-nitpick-ui style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 999, background: 'rgba(20,20,22,0.95)', color: '#fff', boxShadow: '0 4px 20px rgba(0,0,0,0.45)', pointerEvents: 'auto', fontSize: 12 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: ACCENT, boxShadow: '0 0 0 3px rgba(255,45,85,0.3)' }} />
          Recording · {actions.length} action{actions.length === 1 ? '' : 's'}
          <button onClick={() => setRecording(false)} style={{ ...toolBtn(false), padding: '4px 10px' }}>■ Stop</button>
        </div>
      )}

      {active && !recording && (
        <>
          {/* selection / highlight surface */}
          {!snip && (
            /* Size via inline CSS, not width/height attributes: host resets like
               `svg { max-width: 100%; height: auto }` override SVG presentation attributes and
               would collapse this layer to the 150px intrinsic default (Snip then only works in
               the top strip of the viewport). Inline styles win over any host stylesheet. */
            <svg data-nitpick-ui
              style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', maxWidth: 'none', pointerEvents: snipMarqueeActive ? 'auto' : 'none', cursor: snipMarqueeActive ? 'crosshair' : 'default' }}
              onPointerDown={onPageDown} onPointerMove={onPageMove} onPointerUp={onPageUp}>
              <g transform={`translate(${-scroll.x},${-scroll.y})`}>
                {targets.map((t, i) => (
                  <g key={`t${i}`}>
                    <rect x={t.boundingBox.x} y={t.boundingBox.y} width={t.boundingBox.w} height={t.boundingBox.h} fill="rgba(255,45,85,0.08)" stroke={ACCENT} strokeWidth={2} rx={3} />
                    <text x={t.boundingBox.x + 4} y={t.boundingBox.y + 14} fill={ACCENT} fontSize={12} fontWeight={700}>{i + 1}</text>
                  </g>
                ))}
                {marquee && marquee.type === 'rect' && (
                  <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} fill="rgba(255,45,85,0.10)" stroke={ACCENT} strokeWidth={2} strokeDasharray="6 4" />
                )}
              </g>
            </svg>
          )}

          {tool === 'inspect' && hovered && !snip && (
            <div data-nitpick-ui style={{ position: 'fixed', left: hovered.left, top: hovered.top, width: hovered.width, height: hovered.height, outline: `2px solid ${ACCENT}`, background: 'rgba(255,45,85,0.08)', borderRadius: 2, pointerEvents: 'none' }} />
          )}

          {/* SNIP editor */}
          {snip && (
            <div data-nitpick-ui style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,14,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto' }}>
              <div style={{ background: '#1a1a1e', padding: 10, borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.6)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span style={{ color: '#fff', fontSize: 12, fontWeight: 700, marginRight: 'auto' }}>✂ Snip — draw on it, then Save</span>
                  {(['arrow', 'line', 'circle', 'box', 'pen', 'text'] as DrawTool[]).map((t) => (
                    <button key={t} onClick={() => setDrawTool(t)} style={toolBtn(drawTool === t)}>{drawIcon(t)}</button>
                  ))}
                  <button onClick={() => setSnipShapes((a) => a.slice(0, -1))} disabled={!snipShapes.length} style={toolBtn(false)}>↩</button>
                  <button onClick={() => { setSnip(null); setSnipShapes([]); setSnipDraft(null); setSnipText(null); }} title="Discard snip" style={toolBtn(false)}>✕</button>
                </div>
                <div style={{ position: 'relative', width: snip.w * snip.scale, height: snip.h * snip.scale }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={snip.url} alt="snip" style={{ width: snip.w * snip.scale, height: snip.h * snip.scale, display: 'block', borderRadius: 6 }} />
                  {/* width/height as inline CSS (not attributes) — see the marquee svg above */}
                  <svg viewBox={`0 0 ${snip.w} ${snip.h}`}
                    style={{ position: 'absolute', inset: 0, width: snip.w * snip.scale, height: snip.h * snip.scale, maxWidth: 'none', cursor: drawTool === 'text' ? 'text' : 'crosshair' }}
                    onPointerDown={onSnipDown} onPointerMove={onSnipMove} onPointerUp={onSnipUp}>
                    <defs><marker id="np-arrow-snip" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L7,3 L0,6 Z" fill={ACCENT} /></marker></defs>
                    {snipShapes.map((s, i) => renderSnipShape(s, i, snipSw))}
                    {snipDraft && renderSnipShape(snipDraft, -1, snipSw)}
                  </svg>
                  {snipText && (
                    <textarea autoFocus value={snipText.value} placeholder="type, Enter to place"
                      onChange={(e) => setSnipText({ ...snipText, value: e.target.value })}
                      onBlur={commitSnipText}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitSnipText(); }
                        if (e.key === 'Escape') e.stopPropagation(); // global handler dismisses just the text box
                      }}
                      style={{
                        position: 'absolute', left: snipText.x * snip.scale, top: snipText.y * snip.scale,
                        minWidth: 120, minHeight: textSize(snipSw) * snip.scale * 1.6, resize: 'both',
                        font: `700 ${textSize(snipSw) * snip.scale}px ui-sans-serif, system-ui, sans-serif`,
                        color: ACCENT, background: 'rgba(10,10,14,0.35)', caretColor: ACCENT,
                        border: `1px dashed ${ACCENT}`, borderRadius: 4, padding: 0, outline: 'none', overflow: 'hidden',
                      }} />
                  )}
                </div>
              </div>
            </div>
          )}

          {/* draggable toolbox */}
          <div data-nitpick-ui style={{ position: 'fixed', left: pos.x, top: pos.y, width: 480, maxWidth: '96vw', pointerEvents: 'auto', background: 'rgba(24,24,28,0.98)', color: '#fff', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid #333', flexWrap: 'wrap' }}>
              <span data-nitpick-ui title="Drag to move"
                onPointerDown={(e) => { (e.currentTarget as Element).setPointerCapture(e.pointerId); dragOff.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }; }}
                onPointerMove={(e) => { if (dragOff.current) setPos({ x: e.clientX - dragOff.current.x, y: e.clientY - dragOff.current.y }); }}
                onPointerUp={() => { dragOff.current = null; }}
                style={{ cursor: 'grab', userSelect: 'none', fontSize: 16, opacity: 0.7, padding: '0 4px' }}>⠿</span>
              <button onClick={() => pickTool('inspect')} style={toolBtn(tool === 'inspect')}>⌖ Inspect</button>
              <button onClick={() => pickTool('snip')} style={toolBtn(tool === 'snip')}>✂ Snip</button>
              <button onClick={() => { setMetaMode(false); setRecording(true); }} title="Record clicks / inputs / navigation across screens (action flow only)" style={toolBtn(false)}>● Record</button>
              <button onClick={() => { setTool(null); setMetaMode((m) => !m); }} title="Something wrong with Nitpick itself? Describe it and Save — your agent will fix the tool" style={toolBtn(metaMode)}>🛠 Fix me</button>
              <button onClick={undo} title="Undo" style={{ ...toolBtn(false), marginLeft: 'auto' }}>↩</button>
              <button onClick={close} title="Close (Esc)" style={toolBtn(false)}>✕</button>
            </div>
            <div style={{ padding: 10, display: 'flex', gap: 10, alignItems: 'flex-start' }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && f.type.startsWith('image/')) readImage(f); }}>
              <textarea value={comment} onChange={(e) => setComment(e.target.value)}
                placeholder={metaMode
                  ? "What's wrong with Nitpick? Type or dictate it — Save hands it to your agent to fix the tool."
                  : "What's wrong? Pick a tool above (Inspect / Snip / Record), then Save."}
                style={{ flex: 1, minHeight: 52, resize: 'vertical', borderRadius: 8, border: `1px solid ${metaMode ? ACCENT : '#3a3a40'}`, background: '#1a1a1e', color: '#fff', padding: 8, fontSize: 12, boxSizing: 'border-box', outline: 'none' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 128 }}>
                {SpeechRec ? (
                  <button onClick={toggleMic} title={listening ? 'Stop dictating' : 'Dictate your comment'} style={{ ...toolBtn(listening), textAlign: 'center' }}>
                    {listening ? '🎤 listening…' : '🎤 dictate'}
                  </button>
                ) : null}
                {referenceImage ? (
                  <div style={{ position: 'relative' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={referenceImage} alt="reference" style={{ width: '100%', height: 40, objectFit: 'cover', borderRadius: 6, border: '1px solid #3a3a40' }} />
                    <button onClick={() => setReferenceImage(null)} style={badgeX}>×</button>
                  </div>
                ) : (
                  <label style={{ fontSize: 10, opacity: 0.75, cursor: 'pointer', padding: '6px', border: '1px dashed #3a3a40', borderRadius: 8, textAlign: 'center' }}>
                    ＋ reference
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) readImage(f); }} />
                  </label>
                )}
                <button onClick={submit} disabled={submitting} style={{ borderRadius: 8, border: 'none', background: ACCENT, color: '#fff', fontSize: 12, fontWeight: 700, padding: '8px', cursor: submitting ? 'default' : 'pointer', opacity: submitting ? 0.7 : 1 }}>
                  {submitting ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
            {actions.length > 0 ? (
              <div style={{ padding: '6px 10px 9px', fontSize: 11, color: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>🎬</span>
                <span><b>{actions.length}</b> action{actions.length === 1 ? '' : 's'} recorded</span>
                <span style={{ marginLeft: 'auto', opacity: 0.6 }}>add a comment, then Save</span>
              </div>
            ) : (
              <div style={{ padding: '0 10px 8px', fontSize: 10, opacity: 0.6 }}>
                {metaMode ? '🛠 reporting a Nitpick problem — the screenshot will include the Nitpick UI'
                  : tool === 'inspect' ? `${targets.length} element${targets.length === 1 ? '' : 's'} selected — each saved as its own image`
                    : tool === 'snip' ? 'drag a region to snip'
                      : 'pick a tool, or just type a comment'}
              </div>
            )}
          </div>
        </>
      )}

      {/* shown while a screenshot is being produced (excluded from the capture itself) */}
      {capturing && (
        <div data-nitpick-ui data-nitpick-capturing="" style={{ position: 'fixed', inset: 0, zIndex: Z + 10, background: 'rgba(10,10,14,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto', color: '#fff', fontSize: 13, fontWeight: 600, letterSpacing: 0.3 }}>
          📸 Capturing…
        </div>
      )}

      {toast && (
        <div data-nitpick-ui style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', padding: '8px 14px', borderRadius: 999, fontSize: 13, color: '#fff', background: 'rgba(20,20,22,0.95)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>{toast}</div>
      )}
    </div>
  );

  return createPortal(content, document.body);
}

function renderSnipShape(s: Shape, key: number, sw: number) {
  if (s.type === 'rect') return <rect key={key} x={s.x} y={s.y} width={s.w} height={s.h} fill="none" stroke={ACCENT} strokeWidth={sw} />;
  if (s.type === 'ellipse') return <ellipse key={key} cx={s.cx} cy={s.cy} rx={Math.abs(s.rx)} ry={Math.abs(s.ry)} fill="none" stroke={ACCENT} strokeWidth={sw} />;
  if (s.type === 'arrow') return <line key={key} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={ACCENT} strokeWidth={sw} markerEnd="url(#np-arrow-snip)" />;
  if (s.type === 'line') return <line key={key} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={ACCENT} strokeWidth={sw} strokeLinecap="round" />;
  if (s.type === 'text') {
    const fs = textSize(sw);
    return (
      <text key={key} x={s.x} y={s.y} fill={ACCENT} fontSize={fs} fontWeight={700} fontFamily="ui-sans-serif, system-ui, sans-serif" dominantBaseline="hanging">
        {s.text.split('\n').map((line, i) => <tspan key={i} x={s.x} dy={i ? fs * 1.25 : 0}>{line}</tspan>)}
      </text>
    );
  }
  return <path key={key} d={s.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')} fill="none" stroke={ACCENT} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" />;
}
function drawIcon(t: DrawTool): string {
  return t === 'arrow' ? '↗ Arrow' : t === 'line' ? '╱ Line' : t === 'circle' ? '◯ Circle' : t === 'box' ? '▭ Box' : t === 'pen' ? '✎ Pen' : 'T Text';
}
function toolBtn(active: boolean): React.CSSProperties {
  return { fontSize: 11, fontWeight: 600, padding: '5px 8px', borderRadius: 7, cursor: 'pointer', border: `1px solid ${active ? ACCENT : '#3a3a40'}`, background: active ? 'rgba(255,45,85,0.20)' : '#1a1a1e', color: '#fff', whiteSpace: 'nowrap' };
}
const badgeX: React.CSSProperties = { position: 'absolute', top: -8, right: -8, width: 18, height: 18, borderRadius: 9, border: 'none', background: ACCENT, color: '#fff', fontSize: 11, cursor: 'pointer', padding: 0 };
