'use client';

/**
 * Nitpick — in-app visual feedback overlay (dev-only). v2.2.
 *
 * Activate (Ctrl+Shift+. / double-tap Shift / click the badge) → a draggable toolbox appears
 * with NOTHING selected. Tools:
 *   • Inspect  — capture element(s) + Playwright-style locators (stays active for multi-select)
 *   • Draw     — Arrow / Circle / Box / Pen, drawn anywhere on the page (vector annotations)
 *   • Snip     — drag a region, mark it up on the cropped image; saved as a flat image + comment
 *                (drawings are baked into the image — no coordinates are stored)
 *   • Record   — hide the overlay and log clicks / inputs / dropdowns / radios / navigation in
 *                the background, persisted across screens (incl. full reloads)
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
const REC_KEY = '__nitpick_rec';
const ACT_KEY = '__nitpick_actions';
const SHOT_KEY = '__nitpick_shots';
const DRAFT_KEY = '__nitpick_draft';

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

type DrawTool = 'arrow' | 'circle' | 'box' | 'pen';
type Tool = null | 'inspect' | DrawTool | 'snip';

type Shape =
  | { type: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'pen'; pts: [number, number][] }
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

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
interface ScreenShot { route: string } // image is streamed to the server draft; only the ref is kept client-side

const isDrawTool = (t: Tool): t is DrawTool => t === 'arrow' || t === 'circle' || t === 'box' || t === 'pen';

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
function nonPenShape(tool: Tool, s: Pt, p: Pt): Shape {
  if (tool === 'arrow') return { type: 'arrow', x1: s.x, y1: s.y, x2: p.x, y2: p.y };
  if (tool === 'circle') return { type: 'ellipse', cx: (s.x + p.x) / 2, cy: (s.y + p.y) / 2, rx: Math.abs(p.x - s.x) / 2, ry: Math.abs(p.y - s.y) / 2 };
  return { type: 'rect', x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) }; // box / snip marquee
}
// ----------------------------------------------------------------- screenshot

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
    else if (s.type === 'pen') { s.pts.forEach(([px, py], i) => (i ? ctx.lineTo(X(px), Y(py)) : ctx.moveTo(X(px), Y(py)))); ctx.stroke(); }
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
const nitpickFilter = (n: any) => !(n && n.dataset && n.dataset.nitpickUi);

// Snapshot the whole document to a PNG data URL. html-to-image renders document.documentElement
// from the page origin, but when the page is scrolled the captured content is shifted by the
// scroll amount (a known html-to-image issue) — so snip/draw on a scrolled (long) page came out
// misaligned or blank. We scroll to the top for the capture and restore the exact scroll right
// after, so page coordinates always line up with the captured image. `pr` is pre-budgeted by the
// caller (see cappedRatio) to keep tall pages within the browser's max-canvas size.
async function snapshotDoc(pr: number): Promise<string | null> {
  const mod: any = await import('html-to-image').catch(() => null);
  if (!mod || !mod.toPng) return null;
  const sx = window.scrollX, sy = window.scrollY;
  try {
    if (sx || sy) { window.scrollTo(0, 0); await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))); }
    return await mod.toPng(document.documentElement, { pixelRatio: pr, cacheBust: true, filter: nitpickFilter });
  } catch { return null; } finally { if (sx || sy) window.scrollTo(sx, sy); }
}
async function captureFull(shapes: Shape[]): Promise<string | null> {
  const pr = cappedRatio(1600, 5000, 2);
  const dataUrl = await snapshotDoc(pr);
  if (!dataUrl || !shapes.length) return dataUrl;
  try {
    const img = await loadImg(dataUrl);
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0); drawShapes(ctx, shapes, pr, 0, 0); // shapes are PAGE coords → align with the from-origin capture
    return canvas.toDataURL('image/png');
  } catch { return dataUrl; }
}
async function cropRegion(box: Box): Promise<string | null> {
  // Budget the ratio against the FULL page so the intermediate full-page render stays within the
  // browser's max-canvas size on long pages; then crop the (page-coordinate) region out of it.
  const pr = cappedRatio(2000, 8000, 2);
  const dataUrl = await snapshotDoc(pr);
  if (!dataUrl) return null;
  try {
    const img = await loadImg(dataUrl);
    const cw = Math.max(1, Math.round(box.w * pr)); const ch = Math.max(1, Math.round(box.h * pr));
    const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d'); if (!ctx) return null;
    ctx.drawImage(img, box.x * pr, box.y * pr, cw, ch, 0, 0, cw, ch);
    return canvas.toDataURL('image/png');
  } catch { return null; }
}
// Pixel ratio that keeps a capture within a width/height budget (prevents giant canvases /
// multi-MB payloads that can OOM the dev server when many screens are saved at once).
function cappedRatio(maxW: number, maxH: number, hardCap: number): number {
  const w = document.documentElement.scrollWidth || window.innerWidth || 1280;
  const h = document.documentElement.scrollHeight || window.innerHeight || 1000;
  return Math.max(0.1, Math.min(window.devicePixelRatio || 1, hardCap, maxW / w, maxH / h));
}
// Per-screen record shot: small, JPEG-encoded (one per screen → keep the payload tiny).
async function recordShot(): Promise<string | null> {
  try {
    const mod: any = await import('html-to-image').catch(() => null);
    if (!mod || !mod.toPng) return null;
    const pr = cappedRatio(1400, 3000, 1);
    const dataUrl: string = await mod.toPng(document.documentElement, { pixelRatio: pr, cacheBust: true, filter: nitpickFilter });
    const img = await loadImg(dataUrl);
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); if (!ctx) return dataUrl;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0); // white bg for JPEG
    return c.toDataURL('image/jpeg', 0.6);
  } catch { return null; }
}
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

// ----------------------------------------------------------------- session storage

// Recording lives in component memory for the page-view (it survives client-side navigation
// because the component stays mounted) and is streamed to the server draft. We deliberately do
// NOT persist/resume it across full page reloads — only the draft id is tracked, so an abandoned
// draft can be discarded. This keeps the overlay completely inert when not actively in use.
function clearSessionStore() { try { sessionStorage.removeItem(ACT_KEY); sessionStorage.removeItem(REC_KEY); sessionStorage.removeItem(SHOT_KEY); sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } }

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
  const [drawOpen, setDrawOpen] = useState(false);
  const [shapes, setShapes] = useState<Shape[]>([]);   // page annotations (vector, page coords)
  const [draft, setDraft] = useState<Shape | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [snip, setSnip] = useState<Snip | null>(null); // snip editor open when set
  const [snipShapes, setSnipShapes] = useState<Shape[]>([]); // baked into image, never persisted as coords
  const [snipDraft, setSnipDraft] = useState<Shape | null>(null);
  const [capturing, setCapturing] = useState(false); // a screenshot is in flight (masks the brief scroll-to-top)
  const [actions, setActions] = useState<Action[]>([]);
  const [recordShots, setRecordShots] = useState<ScreenShot[]>([]); // one full-page shot per screen visited while recording
  const [hovered, setHovered] = useState<DOMRect | null>(null);
  const [comment, setComment] = useState('');
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [pos, setPos] = useState({ x: 24, y: 16 });

  const drawStart = useRef<Pt | null>(null);
  const snipStart = useRef<Pt | null>(null);
  const dragOff = useRef<Pt | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevRec = useRef(false);
  const draftIdRef = useRef<string | null>(null);
  const lastUrlRef = useRef('');
  const lastShotAtRef = useRef(0);
  const shotCountRef = useRef(0);

  const post = (payload: unknown) =>
    fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

  const ensureDraft = useCallback(() => {
    if (!draftIdRef.current) {
      const idd = `npd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      draftIdRef.current = idd;
      try { sessionStorage.setItem(DRAFT_KEY, idd); } catch { /* ignore */ }
    }
    return draftIdRef.current;
  }, []);

  // remove an abandoned draft (cancel / starting a new session) from the server
  const discardDraft = useCallback(() => {
    const d = draftIdRef.current;
    draftIdRef.current = null;
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    if (d) post({ op: 'discard', draftId: d }).catch(() => {});
  }, []);

  // capture one screen and STREAM it to the server draft (browser keeps only a light ref).
  // Hard caps (min interval + max count) so recording can never storm the dev server.
  const captureRecordShot = useCallback(async () => {
    const now = Date.now();
    if (now - lastShotAtRef.current < 1200 || shotCountRef.current >= 60) return;
    lastShotAtRef.current = now;
    const route = location.pathname + location.search;
    const url = await recordShot();
    if (!url) return;
    const draftId = ensureDraft();
    try { const res = await post({ op: 'stage', draftId, route, image: url }); if (!res.ok) return; } catch { return; }
    shotCountRef.current += 1;
    setRecordShots((prev) => [...prev, { route }].slice(-60));
  }, [ensureDraft]);
  const scheduleShot = useCallback((delay: number) => {
    if (shotTimer.current) clearTimeout(shotTimer.current);
    shotTimer.current = setTimeout(() => { void captureRecordShot(); }, delay);
  }, [captureRecordShot]);

  const showToast = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const close = useCallback(() => {
    setActive(false); setRecording(false); setTool(null); setDrawOpen(false);
    setShapes([]); setDraft(null); setTargets([]); setSnip(null); setSnipShapes([]); setSnipDraft(null);
    setCapturing(false);
    setActions([]); setRecordShots([]); setHovered(null); setComment(''); setReferenceImage(null); setSubmitting(false);
    drawStart.current = null; snipStart.current = null;
    shotCountRef.current = 0; lastShotAtRef.current = 0;
    if (shotTimer.current) clearTimeout(shotTimer.current);
    discardDraft(); // remove any streamed-but-unsubmitted shots
    clearSessionStore();
  }, [discardDraft]);

  const openTools = useCallback(() => {
    // starting a NEW session: drop any draft left over from a cancelled/unsubmitted one
    try { const leftover = sessionStorage.getItem(DRAFT_KEY); if (leftover) post({ op: 'discard', draftId: leftover }).catch(() => {}); } catch { /* ignore */ }
    draftIdRef.current = null;
    clearSessionStore();
    setActive(true); setRecording(false); setTool(null); setDrawOpen(false); setSubmitting(false);
    setActions([]); setRecordShots([]);
    if (typeof window !== 'undefined') { setScroll({ x: window.scrollX, y: window.scrollY }); setPos({ x: Math.max(8, (window.innerWidth - 520) / 2), y: 14 }); }
  }, []);

  // mount — start clean. We do NOT silently auto-resume a recording across page loads (that
  // could keep capturing in the background and grow the dev-server heap). A fresh page load
  // abandons any prior session: discard its server draft and clear local keys. (Recording still
  // works across client-side navigation, since the component stays mounted then.)
  useEffect(() => {
    setMounted(true);
    // eslint-disable-next-line no-console
    console.info(`[Nitpick] ready — ${hotkeyLabel(hotkey)} / double-tap Shift / click the badge.`);
    try {
      const leftover = sessionStorage.getItem(DRAFT_KEY);
      if (leftover) post({ op: 'discard', draftId: leftover }).catch(() => {});
    } catch { /* ignore */ }
    clearSessionStore();
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
        else if (snip) { setSnip(null); setSnipShapes([]); setSnipDraft(null); }
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

  // keep page annotation layer aligned while scrolling
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

  // Record — overlay hidden; capture clicks / inputs (text, select, radio, checkbox) / submit / navigation
  useEffect(() => {
    if (!active || !recording) return;
    shotCountRef.current = 0; lastShotAtRef.current = 0; // reset safety caps for this recording
    const onUi = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-nitpick-ui]');
    const record = (a: Omit<Action, 'at' | 'url'>) =>
      setActions((prev) => [...prev, { ...a, at: new Date().toISOString(), url: location.pathname + location.search }]);
    ensureDraft(); // so the streamed shots have a draft to land in (and can be discarded)
    lastUrlRef.current = location.pathname + location.search;
    record({ type: 'navigate' });
    scheduleShot(450); // snapshot this screen once it settles
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
        scheduleShot(750); // new screen needs a moment to render
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
  }, [active, recording, scheduleShot, ensureDraft]);

  // snapshot the final screen when recording stops, then reconcile state with the persisted
  // store so the toolbox shows everything captured across all screens before the user submits.
  useEffect(() => {
    if (prevRec.current && !recording && active) void captureRecordShot(); // snapshot the final screen
    prevRec.current = recording;
  }, [recording, active, captureRecordShot]);


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

  // ----- page drawing / snip marquee (page coords) -----
  const pagePt = (e: React.PointerEvent): Pt => ({ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY });
  const onPageDown = (e: React.PointerEvent) => {
    if (!(tool === 'snip' || isDrawTool(tool))) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = pagePt(e); drawStart.current = p;
    setDraft(tool === 'pen' ? { type: 'pen', pts: [[p.x, p.y]] } : nonPenShape(tool, p, p));
  };
  const onPageMove = (e: React.PointerEvent) => {
    const s = drawStart.current; if (!s) return; const p = pagePt(e);
    if (tool === 'pen') setDraft((d) => (d && d.type === 'pen' ? { type: 'pen', pts: [...d.pts, [p.x, p.y]] } : d));
    else setDraft(nonPenShape(tool, s, p));
  };
  const onPageUp = async () => {
    const d = draft; drawStart.current = null; setDraft(null);
    if (!d) return;
    if (tool === 'snip') {
      if (d.type === 'rect' && d.w > 6 && d.h > 6) {
        const box = { x: d.x, y: d.y, w: d.w, h: d.h };
        setCapturing(true);
        const url = await withTimeout(cropRegion(box), 8000, null);
        setCapturing(false);
        if (url) {
          const img = await loadImg(url);
          const scale = Math.min(Math.min(window.innerWidth * 0.8, 900) / img.width, (window.innerHeight * 0.65) / img.height, 1);
          setSnip({ url, w: img.width, h: img.height, scale, box }); setSnipShapes([]); setTool('arrow'); setDrawOpen(true);
        } else showToast('Snip failed (html-to-image)');
      }
    } else {
      setShapes((arr) => [...arr, d]);
    }
  };

  // ----- snip-editor drawing (image-local coords, baked into the image — no stored coords) -----
  const snipPt = (e: React.PointerEvent): Pt => {
    const r = (e.currentTarget as Element).getBoundingClientRect(); const sc = snip ? snip.scale : 1;
    return { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
  };
  const onSnipDown = (e: React.PointerEvent) => {
    if (!isDrawTool(tool)) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = snipPt(e); snipStart.current = p;
    setSnipDraft(tool === 'pen' ? { type: 'pen', pts: [[p.x, p.y]] } : nonPenShape(tool, p, p));
  };
  const onSnipMove = (e: React.PointerEvent) => {
    const s = snipStart.current; if (!s) return; const p = snipPt(e);
    if (tool === 'pen') setSnipDraft((d) => (d && d.type === 'pen' ? { type: 'pen', pts: [...d.pts, [p.x, p.y]] } : d));
    else setSnipDraft(nonPenShape(tool, s, p));
  };
  const onSnipUp = () => { const d = snipDraft; snipStart.current = null; setSnipDraft(null); if (d) setSnipShapes((a) => [...a, d]); };

  const undo = () => {
    if (snip) return setSnipShapes((a) => a.slice(0, -1));
    if (shapes.length) return setShapes((s) => s.slice(0, -1));
    if (targets.length) return setTargets((t) => t.slice(0, -1));
    if (actions.length) return setActions((a) => a.slice(0, -1));
  };

  const pickTool = (t: Tool) => { setTool(t); if (isDrawTool(t)) setDrawOpen(true); else if (t !== null) setDrawOpen(false); };

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true); setCapturing(true);
    try {
      const isSnip = !!snip;
      const hasDrawing = !!draft || shapes.length > 0;
      const liveActions = actions;
      const liveShots = recordShots;
      const draftId = draftIdRef.current; // recording screens are already on the server draft
      const isRecording = !isSnip && (liveShots.length > 0 || liveActions.length > 0 || !!draftId);
      let screenshot: string | null = null;
      if (isSnip && snip) screenshot = await withTimeout(flattenSnip(snip.url, snipShapes), 8000, snip.url);
      else if (hasDrawing) { const all = draft ? [...shapes, draft] : shapes; screenshot = await withTimeout(captureFull(all), 8000, null); }
      else if (!(isRecording && liveShots.length)) screenshot = await withTimeout(captureFull([]), 8000, null);
      // (recording: per-screen images live in the server draft → single screenshot skipped)
      const reportTargets = isSnip ? [] : targets; // snip is image-only; Inspect supplies element targets
      const payload = {
        comment,
        route: window.location.pathname + window.location.search,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1, scrollX: window.scrollX, scrollY: window.scrollY },
        captureType: isSnip ? 'snip' : isRecording ? 'recording' : 'full',
        coordSpace: isSnip ? null : 'page',
        // snip drawings are baked into the image — no coordinates are stored
        annotations: isSnip ? [] : (draft ? [...shapes, draft] : shapes),
        targets: reportTargets,
        element: reportTargets[0] ?? null,
        actions: liveActions,
        draftId, // server promotes the streamed shots into this report's screens[]
        screenshot, referenceImage,
      };
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        draftIdRef.current = null; try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } // server consumed the draft
        showToast(`📍 Saved feedback #${data.id ?? ''}`); close();
      } else showToast(`Save failed (${res.status})`);
    } catch { showToast('Save failed — is the dev server running?'); } finally { setSubmitting(false); setCapturing(false); }
  }, [submitting, snip, snipShapes, shapes, draft, comment, targets, actions, recordShots, referenceImage, close, showToast]);

  if (!mounted) return null;

  const renderShape = (s: Shape, key: number, sw = 3) => {
    if (s.type === 'rect') return <rect key={key} x={s.x} y={s.y} width={s.w} height={s.h} fill="none" stroke={ACCENT} strokeWidth={sw} />;
    if (s.type === 'ellipse') return <ellipse key={key} cx={s.cx} cy={s.cy} rx={Math.abs(s.rx)} ry={Math.abs(s.ry)} fill="none" stroke={ACCENT} strokeWidth={sw} />;
    if (s.type === 'arrow') return <line key={key} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={ACCENT} strokeWidth={sw} markerEnd="url(#np-arrow)" />;
    return <path key={key} d={s.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')} fill="none" stroke={ACCENT} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" />;
  };

  const pageDrawActive = active && !recording && !snip && (tool === 'snip' || isDrawTool(tool));
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
          Recording · {actions.length} action{actions.length === 1 ? '' : 's'} · {recordShots.length} screen{recordShots.length === 1 ? '' : 's'}
          <button onClick={() => setRecording(false)} style={{ ...toolBtn(false), padding: '4px 10px' }}>■ Stop</button>
        </div>
      )}

      {active && !recording && (
        <>
          {/* page annotation surface */}
          {!snip && (
            <svg data-nitpick-ui width="100%" height="100%"
              style={{ position: 'fixed', inset: 0, pointerEvents: pageDrawActive ? 'auto' : 'none', cursor: pageDrawActive ? 'crosshair' : 'default' }}
              onPointerDown={onPageDown} onPointerMove={onPageMove} onPointerUp={onPageUp}>
              <defs>
                <marker id="np-arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L7,3 L0,6 Z" fill={ACCENT} /></marker>
              </defs>
              <g transform={`translate(${-scroll.x},${-scroll.y})`}>
                {targets.map((t, i) => (
                  <g key={`t${i}`}>
                    <rect x={t.boundingBox.x} y={t.boundingBox.y} width={t.boundingBox.w} height={t.boundingBox.h} fill="rgba(255,45,85,0.08)" stroke={ACCENT} strokeWidth={2} rx={3} />
                    <text x={t.boundingBox.x + 4} y={t.boundingBox.y + 14} fill={ACCENT} fontSize={12} fontWeight={700}>{i + 1}</text>
                  </g>
                ))}
                {shapes.map((s, i) => renderShape(s, i))}
                {draft && renderShape(draft, -1)}
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
                  {(['arrow', 'circle', 'box', 'pen'] as DrawTool[]).map((t) => (
                    <button key={t} onClick={() => setTool(t)} style={toolBtn(tool === t)}>{drawIcon(t)}</button>
                  ))}
                  <button onClick={() => setSnipShapes((a) => a.slice(0, -1))} disabled={!snipShapes.length} style={toolBtn(false)}>↩</button>
                  <button onClick={() => { setSnip(null); setSnipShapes([]); setSnipDraft(null); }} title="Discard snip" style={toolBtn(false)}>✕</button>
                </div>
                <div style={{ position: 'relative', width: snip.w * snip.scale, height: snip.h * snip.scale }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={snip.url} alt="snip" style={{ width: snip.w * snip.scale, height: snip.h * snip.scale, display: 'block', borderRadius: 6 }} />
                  <svg viewBox={`0 0 ${snip.w} ${snip.h}`} width={snip.w * snip.scale} height={snip.h * snip.scale}
                    style={{ position: 'absolute', inset: 0, cursor: isDrawTool(tool) ? 'crosshair' : 'default' }}
                    onPointerDown={onSnipDown} onPointerMove={onSnipMove} onPointerUp={onSnipUp}>
                    <defs><marker id="np-arrow-snip" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L7,3 L0,6 Z" fill={ACCENT} /></marker></defs>
                    {snipShapes.map((s, i) => renderSnipShape(s, i, snipSw))}
                    {snipDraft && renderSnipShape(snipDraft, -1, snipSw)}
                  </svg>
                </div>
              </div>
            </div>
          )}

          {/* draggable toolbox */}
          <div data-nitpick-ui style={{ position: 'fixed', left: pos.x, top: pos.y, width: 520, maxWidth: '96vw', pointerEvents: 'auto', background: 'rgba(24,24,28,0.98)', color: '#fff', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid #333', flexWrap: 'wrap' }}>
              <span data-nitpick-ui title="Drag to move"
                onPointerDown={(e) => { (e.currentTarget as Element).setPointerCapture(e.pointerId); dragOff.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }; }}
                onPointerMove={(e) => { if (dragOff.current) setPos({ x: e.clientX - dragOff.current.x, y: e.clientY - dragOff.current.y }); }}
                onPointerUp={() => { dragOff.current = null; }}
                style={{ cursor: 'grab', userSelect: 'none', fontSize: 16, opacity: 0.7, padding: '0 4px' }}>⠿</span>
              <button onClick={() => pickTool('inspect')} style={toolBtn(tool === 'inspect')}>⌖ Inspect</button>
              <button onClick={() => { setDrawOpen((o) => !o || !isDrawTool(tool)); if (!isDrawTool(tool)) setTool('arrow'); }} style={toolBtn(isDrawTool(tool))}>✎ Draw ▾</button>
              <button onClick={() => pickTool('snip')} style={toolBtn(tool === 'snip')}>✂ Snip</button>
              <button onClick={() => setRecording(true)} title="Record clicks / inputs / navigation across screens" style={toolBtn(false)}>● Record</button>
              <button onClick={undo} title="Undo" style={{ ...toolBtn(false), marginLeft: 'auto' }}>↩</button>
              <button onClick={close} title="Close (Esc)" style={toolBtn(false)}>✕</button>
            </div>
            {drawOpen && (
              <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderBottom: '1px solid #333', alignItems: 'center' }}>
                {(['arrow', 'circle', 'box', 'pen'] as DrawTool[]).map((t) => (
                  <button key={t} onClick={() => setTool(t)} style={toolBtn(tool === t)}>{drawIcon(t)}</button>
                ))}
              </div>
            )}
            <div style={{ padding: 10, display: 'flex', gap: 10, alignItems: 'flex-start' }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && f.type.startsWith('image/')) readImage(f); }}>
              <textarea value={comment} onChange={(e) => setComment(e.target.value)}
                placeholder="What's wrong? Pick a tool above (Inspect / Draw / Snip / Record), then Save."
                style={{ flex: 1, minHeight: 52, resize: 'vertical', borderRadius: 8, border: '1px solid #3a3a40', background: '#1a1a1e', color: '#fff', padding: 8, fontSize: 12, boxSizing: 'border-box', outline: 'none' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 128 }}>
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
            {(actions.length > 0 || recordShots.length > 0) ? (
              <div style={{ padding: '6px 10px 9px', fontSize: 11, color: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>🎬</span>
                <span><b>{actions.length}</b> action{actions.length === 1 ? '' : 's'} · <b>{recordShots.length}</b> screen{recordShots.length === 1 ? '' : 's'} captured</span>
                <span style={{ marginLeft: 'auto', opacity: 0.6 }}>add a comment, then Save</span>
              </div>
            ) : (
              <div style={{ padding: '0 10px 8px', fontSize: 10, opacity: 0.6 }}>
                {snip ? 'snip image' : `${targets.length} element${targets.length === 1 ? '' : 's'} · ${shapes.length} drawing${shapes.length === 1 ? '' : 's'} · full-page shot`}
              </div>
            )}
          </div>
        </>
      )}

      {/* masks the momentary scroll-to-top during a screenshot; excluded from the capture itself */}
      {capturing && (
        <div data-nitpick-ui style={{ position: 'fixed', inset: 0, zIndex: Z + 10, background: 'rgba(10,10,14,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto', color: '#fff', fontSize: 13, fontWeight: 600, letterSpacing: 0.3 }}>
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
  return <path key={key} d={s.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')} fill="none" stroke={ACCENT} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" />;
}
function drawIcon(t: DrawTool): string {
  return t === 'arrow' ? '↗ Arrow' : t === 'circle' ? '◯ Circle' : t === 'box' ? '▭ Box' : '✎ Pen';
}
function toolBtn(active: boolean): React.CSSProperties {
  return { fontSize: 11, fontWeight: 600, padding: '5px 8px', borderRadius: 7, cursor: 'pointer', border: `1px solid ${active ? ACCENT : '#3a3a40'}`, background: active ? 'rgba(255,45,85,0.20)' : '#1a1a1e', color: '#fff', whiteSpace: 'nowrap' };
}
const badgeX: React.CSSProperties = { position: 'absolute', top: -8, right: -8, width: 18, height: 18, borderRadius: 9, border: 'none', background: ACCENT, color: '#fff', fontSize: 11, cursor: 'pointer', padding: 0 };
