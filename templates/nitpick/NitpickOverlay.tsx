'use client';

/**
 * Nitpick — in-app visual feedback overlay (dev-only). v2.1.
 *
 * Activate (Ctrl+Shift+. / double-tap Shift / click the badge) → a draggable toolbox appears.
 * Tools: Inspect (capture element + Playwright-style locators; stays active for multi-select),
 * Arrow, Pen, Rectangle (draw anywhere — no element required), Area (snip a region), and
 * Record (hide the overlay and log clicks/inputs/navigation in the background, persisted across
 * screens). Add a comment / reference image, then Save → POST to /api/nitpick → `.nitpick/`.
 *
 * Self-contained: only React + ./nitpick-source. Screenshots are best-effort via an optional
 * dynamic import of `html-to-image` (with a timeout so Save never hangs).
 *
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

// ----------------------------------------------------------------- hotkey (config + matching)

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

// --------------------------------------------------------------------------------- types

type DrawTool = 'arrow' | 'pen' | 'rect';
type Tool = 'inspect' | DrawTool | 'region';

type Shape =
  | { type: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'pen'; pts: [number, number][] }
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number }; // legacy render support

interface Box { x: number; y: number; w: number; h: number }

interface Locators {
  role: string | null; name: string; testId: { attr: string; value: string } | null;
  getBy: string | null; css: string; xpath: string; outerTag: string;
}
interface Target {
  source: ElementInfo['source']; componentName: string | null; componentStack: string[];
  tag: string; id: string; classes: string[]; text: string; dataAttributes: Record<string, string>;
  locators: Locators; boundingBox: Box; computedStyles: Record<string, string>;
}
interface Action {
  type: 'click' | 'input' | 'submit' | 'navigate';
  at: string; url: string; locator?: Locators; tag?: string; text?: string; value?: string;
}

// --------------------------------------------------------------------------------- DOM helpers

const STYLE_KEYS = [
  'display', 'position', 'width', 'height', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderRadius', 'borderTopWidth',
  'borderColor', 'boxShadow', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily',
  'lineHeight', 'letterSpacing', 'textAlign', 'flexDirection', 'justifyContent', 'alignItems', 'gap',
  'gridTemplateColumns', 'zIndex', 'opacity', 'overflow', 'transform',
];
const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
function getStyleSubset(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const k of STYLE_KEYS) { const v = cs.getPropertyValue(kebab(k)); if (v && v.trim() !== '') out[k] = v.trim(); }
  return out;
}
function buildSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
    if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}
function xpathOf(el: Element): string {
  if (el.id) return `//*[@id=${JSON.stringify(el.id)}]`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.body) {
    let i = 1; let sib = node.previousElementSibling;
    while (sib) { if (sib.tagName === node.tagName) i++; sib = sib.previousElementSibling; }
    parts.unshift(`${node.tagName.toLowerCase()}[${i}]`);
    node = node.parentElement;
  }
  return '/html/body/' + parts.join('/');
}
const INPUT_ROLE: Record<string, string | null> = {
  checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button',
  reset: 'button', search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
  number: 'spinbutton', text: 'textbox', password: null,
};
const TAG_ROLE: Record<string, string> = {
  button: 'button', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
  aside: 'complementary', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading',
  h6: 'heading', ul: 'list', ol: 'list', li: 'listitem', table: 'table', select: 'combobox',
  textarea: 'textbox', form: 'form', section: 'region', dialog: 'dialog',
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
  for (const a of ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa']) {
    const v = el.getAttribute(a); if (v) return { attr: a, value: v };
  }
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
  const info = resolveElementInfo(el);
  const r = el.getBoundingClientRect();
  const dataAttributes: Record<string, string> = {};
  const ds = (el as HTMLElement).dataset || {};
  for (const k of Object.keys(ds)) { if (!k.startsWith('nitpick')) dataAttributes[k] = ds[k] as string; }
  return {
    source: info.source, componentName: info.componentName, componentStack: info.componentStack,
    tag: el.tagName.toLowerCase(), id: (el as HTMLElement).id || '', classes: Array.from(el.classList || []),
    text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140), dataAttributes,
    locators: buildLocators(el),
    boundingBox: { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) },
    computedStyles: getStyleSubset(el),
  };
}
function interactiveAncestor(el: Element): Element {
  return el.closest('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input, select, textarea, summary, label, [onclick]') || el;
}

// --------------------------------------------------------------------------------- screenshot

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = src; });
}
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);
}
function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[], dpr: number, ox: number, oy: number) {
  ctx.strokeStyle = ACCENT; ctx.fillStyle = ACCENT; ctx.lineWidth = Math.max(2, 2.5 * dpr); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
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
async function captureScreenshot(shapes: Shape[], region: Box | null): Promise<string | null> {
  try {
    const mod: any = await import('html-to-image').catch(() => null);
    if (!mod || !mod.toPng) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const dataUrl: string = await mod.toPng(document.documentElement, {
      pixelRatio: dpr, cacheBust: true, filter: (n: any) => !(n && n.dataset && n.dataset.nitpickUi),
    });
    const img = await loadImg(dataUrl);
    const ox = region ? region.x : 0; const oy = region ? region.y : 0;
    const cw = Math.max(1, Math.round((region ? region.w : img.width / dpr) * dpr));
    const ch = Math.max(1, Math.round((region ? region.h : img.height / dpr) * dpr));
    const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d'); if (!ctx) return dataUrl;
    ctx.drawImage(img, ox * dpr, oy * dpr, cw, ch, 0, 0, cw, ch);
    if (shapes.length) drawShapes(ctx, shapes, dpr, ox, oy);
    return canvas.toDataURL('image/png');
  } catch { return null; }
}

// --------------------------------------------------------------------------------- session storage

function loadActions(): Action[] { try { return JSON.parse(sessionStorage.getItem(ACT_KEY) || '[]'); } catch { return []; } }
function saveActions(a: Action[]) { try { sessionStorage.setItem(ACT_KEY, JSON.stringify(a)); } catch { /* ignore */ } }
function clearSessionStore() { try { sessionStorage.removeItem(ACT_KEY); sessionStorage.removeItem(REC_KEY); } catch { /* ignore */ } }

// --------------------------------------------------------------------------------- component

export default function NitpickOverlay({ hotkey }: { hotkey?: Hotkey } = {}) {
  if (process.env.NODE_ENV === 'production') return null;
  return <NitpickOverlayInner hotkey={hotkey ?? DEFAULT_HOTKEY} />;
}

function NitpickOverlayInner({ hotkey }: { hotkey: Hotkey }) {
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [tool, setTool] = useState<Tool>('inspect');
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [region, setRegion] = useState<Box | null>(null);
  const [regionShot, setRegionShot] = useState<string | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [hovered, setHovered] = useState<DOMRect | null>(null);
  const [comment, setComment] = useState('');
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [pos, setPos] = useState({ x: 24, y: 16 });

  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const dragOff = useRef<{ x: number; y: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const close = useCallback(() => {
    setActive(false); setRecording(false); setTool('inspect');
    setShapes([]); setDraft(null); setTargets([]); setRegion(null); setRegionShot(null);
    setActions([]); setHovered(null); setComment(''); setReferenceImage(null); setSubmitting(false);
    drawStart.current = null;
    clearSessionStore();
  }, []);

  const openTools = useCallback(() => {
    setActive(true); setRecording(false); setTool('inspect'); setSubmitting(false);
    if (typeof window !== 'undefined') {
      setScroll({ x: window.scrollX, y: window.scrollY });
      setPos({ x: Math.max(8, (window.innerWidth - 520) / 2), y: 14 });
    }
  }, []);

  // mount + restore any in-progress recording session (persists across full page reloads)
  useEffect(() => {
    setMounted(true);
    // eslint-disable-next-line no-console
    console.info(`[Nitpick] ready — ${hotkeyLabel(hotkey)} / double-tap Shift / click the badge.`);
    let resumed = false;
    try {
      const acts = loadActions();
      const wasRec = sessionStorage.getItem(REC_KEY) === '1';
      if (acts.length || wasRec) {
        resumed = true;
        setActions(acts);
        setActive(true);
        setRecording(wasRec);
        setPos({ x: Math.max(8, (window.innerWidth - 520) / 2), y: 14 });
      }
    } catch { /* ignore */ }
    if (resumed) showToast('📍 Nitpick session resumed');
  }, [hotkey, showToast]);

  // activation (combo, double-tap Shift, Esc)
  useEffect(() => {
    let lastShift = 0;
    const toggle = () => (active ? close() : openTools());
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchHotkey(e, hotkey)) { e.preventDefault(); toggle(); return; }
      if (e.key === 'Escape' && active) {
        e.preventDefault();
        if (recording) setRecording(false); // stop recording first; keep the session/toolbox
        else close();
        return;
      }
      if (e.key !== 'Shift') lastShift = 0;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return;
      const n = Date.now();
      if (n - lastShift > 40 && n - lastShift < 450) { lastShift = 0; if (!active) openTools(); }
      else lastShift = n;
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => { window.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('keyup', onKeyUp, true); };
  }, [active, recording, hotkey, close, openTools]);

  // keep annotation layer aligned while scrolling
  useEffect(() => {
    if (!active || recording) return;
    const onScroll = () => setScroll({ x: window.scrollX, y: window.scrollY });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [active, recording]);

  // persist actions for cross-screen continuity
  useEffect(() => { if (active) saveActions(actions); }, [actions, active]);

  // Inspect: hover highlight + click to capture element(s). Stays active after each pick.
  useEffect(() => {
    if (!active || recording || tool !== 'inspect') { setHovered(null); return; }
    const onUi = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-nitpick-ui]');
    const under = (x: number, y: number): Element | null => {
      const el = document.elementFromPoint(x, y);
      if (!el || onUi(el)) return null;
      if (el === document.documentElement || el === document.body) return null;
      return el;
    };
    const onMove = (e: MouseEvent) => { if (onUi(e.target)) return; const el = under(e.clientX, e.clientY); setHovered(el ? el.getBoundingClientRect() : null); };
    const onClick = (e: MouseEvent) => {
      if (onUi(e.target)) return; // let toolbox clicks (comment box, buttons) work
      const el = under(e.clientX, e.clientY); if (!el) return;
      e.preventDefault(); e.stopPropagation();
      setTargets((t) => [...t, captureTarget(el)]);
    };
    const block = (e: Event) => { if (onUi(e.target)) return; e.preventDefault(); e.stopPropagation(); };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('mousedown', block, true);
    window.addEventListener('mouseup', block, true);
    return () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('mousedown', block, true);
      window.removeEventListener('mouseup', block, true);
    };
  }, [active, recording, tool]);

  // Recording: overlay hides; capture clicks / inputs / submits / navigation in the background.
  useEffect(() => {
    if (!active || !recording) return;
    try { sessionStorage.setItem(REC_KEY, '1'); } catch { /* ignore */ }
    const onUi = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-nitpick-ui]');
    const record = (a: Omit<Action, 'at' | 'url'>) =>
      setActions((prev) => {
        const next = [...prev, { ...a, at: new Date().toISOString(), url: location.pathname + location.search }];
        saveActions(next);
        return next;
      });
    record({ type: 'navigate' }); // anchor the current screen
    const onClick = (e: MouseEvent) => {
      if (onUi(e.target) || !(e.target instanceof Element)) return;
      const el = interactiveAncestor(e.target);
      record({ type: 'click', locator: buildLocators(el), tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) });
    };
    const onChange = (e: Event) => {
      const t = e.target;
      if (onUi(t)) return;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) {
        const pw = t instanceof HTMLInputElement && t.type === 'password';
        record({ type: 'input', locator: buildLocators(t), value: pw ? '***' : String((t as any).value ?? '').slice(0, 120) });
      }
    };
    const onSubmit = (e: Event) => { if (!onUi(e.target) && e.target instanceof Element) record({ type: 'submit', locator: buildLocators(e.target) }); };
    const onNav = () => record({ type: 'navigate' });
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('submit', onSubmit, true);
    window.addEventListener('popstate', onNav);
    const origPush = history.pushState; const origReplace = history.replaceState;
    history.pushState = function (this: History, ...args: any[]) { const r = origPush.apply(this, args as any); onNav(); return r; } as typeof history.pushState;
    history.replaceState = function (this: History, ...args: any[]) { const r = origReplace.apply(this, args as any); onNav(); return r; } as typeof history.replaceState;
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('submit', onSubmit, true);
      window.removeEventListener('popstate', onNav);
      history.pushState = origPush; history.replaceState = origReplace;
    };
  }, [active, recording]);

  // when recording stops, clear the persisted flag (keep actions for the report)
  useEffect(() => { if (active && !recording) { try { sessionStorage.removeItem(REC_KEY); } catch { /* ignore */ } } }, [active, recording]);

  // reference image via paste while active (not recording)
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
    const r = new FileReader();
    r.onload = () => setReferenceImage(typeof r.result === 'string' ? r.result : null);
    r.readAsDataURL(file);
  }, []);

  const snipRegion = useCallback(async (box: Box) => {
    const url = await withTimeout(captureScreenshot([], box), 8000, null);
    if (url) setRegionShot(url);
  }, []);

  // ----- drawing (page coords) -----
  const pagePt = (e: React.PointerEvent) => ({ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY });
  const onDrawStart = (e: React.PointerEvent) => {
    if (tool === 'inspect') return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = pagePt(e); drawStart.current = p;
    if (tool === 'pen') setDraft({ type: 'pen', pts: [[p.x, p.y]] });
    else if (tool === 'arrow') setDraft({ type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y });
    else setDraft({ type: 'rect', x: p.x, y: p.y, w: 0, h: 0 }); // rect or region
  };
  const onDrawMove = (e: React.PointerEvent) => {
    const s = drawStart.current; if (!s) return; const p = pagePt(e);
    if (tool === 'pen') setDraft((d) => (d && d.type === 'pen' ? { type: 'pen', pts: [...d.pts, [p.x, p.y]] } : d));
    else if (tool === 'arrow') setDraft({ type: 'arrow', x1: s.x, y1: s.y, x2: p.x, y2: p.y });
    else setDraft({ type: 'rect', x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const onDrawEnd = () => {
    const d = draft; drawStart.current = null; setDraft(null);
    if (!d) return;
    if (tool === 'region') {
      if (d.type === 'rect' && d.w > 4 && d.h > 4) { const box = { x: d.x, y: d.y, w: d.w, h: d.h }; setRegion(box); void snipRegion(box); }
      setTool('inspect');
    } else { setShapes((s) => [...s, d]); }
  };

  const undo = () => {
    if (shapes.length) return setShapes((s) => s.slice(0, -1));
    if (region) { setRegion(null); setRegionShot(null); return; }
    if (targets.length) return setTargets((t) => t.slice(0, -1));
    if (actions.length) return setActions((a) => a.slice(0, -1));
  };

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const all = draft ? [...shapes, draft] : shapes;
      const screenshot = await withTimeout(captureScreenshot(all, region), 8000, null);
      const payload = {
        comment,
        route: window.location.pathname + window.location.search,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1, scrollX: window.scrollX, scrollY: window.scrollY },
        captureType: region ? 'region' : 'full',
        region, coordSpace: 'page',
        annotations: all,
        targets, element: targets[0] ?? null,
        actions,
        screenshot, referenceImage,
      };
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { showToast(`📍 Saved feedback #${data.id ?? ''}`); close(); }
      else showToast(`Save failed (${res.status})`);
    } catch {
      showToast('Save failed — is the dev server running?');
    } finally {
      setSubmitting(false);
    }
  }, [submitting, shapes, draft, region, comment, targets, actions, referenceImage, close, showToast]);

  if (!mounted) return null;

  const renderShape = (s: Shape, key: number) => {
    if (s.type === 'rect') return <rect key={key} x={s.x} y={s.y} width={s.w} height={s.h} fill="none" stroke={ACCENT} strokeWidth={3} />;
    if (s.type === 'ellipse') return <ellipse key={key} cx={s.cx} cy={s.cy} rx={Math.abs(s.rx)} ry={Math.abs(s.ry)} fill="none" stroke={ACCENT} strokeWidth={3} />;
    if (s.type === 'arrow') return <line key={key} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={ACCENT} strokeWidth={3} markerEnd="url(#np-arrow)" />;
    return <path key={key} d={s.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')} fill="none" stroke={ACCENT} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />;
  };

  const drawingActive = active && !recording && tool !== 'inspect';

  const content = (
    <div data-nitpick-ui="root" style={{ position: 'fixed', inset: 0, zIndex: Z, pointerEvents: 'none', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      {/* IDLE badge */}
      {!active && (
        <button data-nitpick-ui onClick={openTools} title={`Activate Nitpick — ${hotkeyLabel(hotkey)} or double-tap Shift`}
          style={{ position: 'fixed', bottom: 12, right: 12, padding: '7px 11px', borderRadius: 8, fontSize: 11, color: '#fff', background: 'rgba(20,20,22,0.82)', boxShadow: '0 2px 10px rgba(0,0,0,0.3)', border: 'none', cursor: 'pointer', pointerEvents: 'auto', fontFamily: 'inherit' }}>
          📍 Nitpick · <b>{hotkeyLabel(hotkey)}</b>
        </button>
      )}

      {/* RECORDING: overlay hidden, only a small indicator (events captured in the background) */}
      {active && recording && (
        <div data-nitpick-ui style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 999, background: 'rgba(20,20,22,0.95)', color: '#fff', boxShadow: '0 4px 20px rgba(0,0,0,0.45)', pointerEvents: 'auto', fontSize: 12 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: ACCENT, boxShadow: `0 0 0 3px rgba(255,45,85,0.3)` }} />
          Recording · {actions.length} action{actions.length === 1 ? '' : 's'}
          <button onClick={() => setRecording(false)} style={{ ...toolBtn(false), padding: '4px 10px' }}>■ Stop</button>
        </div>
      )}

      {active && !recording && (
        <>
          {/* annotation + capture surface */}
          <svg data-nitpick-ui width="100%" height="100%"
            style={{ position: 'fixed', inset: 0, pointerEvents: drawingActive ? 'auto' : 'none', cursor: drawingActive ? 'crosshair' : 'default' }}
            onPointerDown={onDrawStart} onPointerMove={onDrawMove} onPointerUp={onDrawEnd}>
            <defs>
              <marker id="np-arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L7,3 L0,6 Z" fill={ACCENT} />
              </marker>
            </defs>
            <g transform={`translate(${-scroll.x},${-scroll.y})`}>
              {region && <rect x={region.x} y={region.y} width={region.w} height={region.h} fill="rgba(255,45,85,0.06)" stroke={ACCENT} strokeWidth={2} strokeDasharray="6 4" />}
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

          {tool === 'inspect' && hovered && (
            <div data-nitpick-ui style={{ position: 'fixed', left: hovered.left, top: hovered.top, width: hovered.width, height: hovered.height, outline: `2px solid ${ACCENT}`, background: 'rgba(255,45,85,0.08)', borderRadius: 2, pointerEvents: 'none' }} />
          )}

          {/* draggable toolbox */}
          <div data-nitpick-ui style={{ position: 'fixed', left: pos.x, top: pos.y, width: 520, maxWidth: '96vw', pointerEvents: 'auto', background: 'rgba(24,24,28,0.98)', color: '#fff', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid #333', flexWrap: 'wrap' }}>
              <span data-nitpick-ui title="Drag to move"
                onPointerDown={(e) => { (e.currentTarget as Element).setPointerCapture(e.pointerId); dragOff.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }; }}
                onPointerMove={(e) => { if (dragOff.current) setPos({ x: e.clientX - dragOff.current.x, y: e.clientY - dragOff.current.y }); }}
                onPointerUp={() => { dragOff.current = null; }}
                style={{ cursor: 'grab', userSelect: 'none', fontSize: 16, opacity: 0.7, padding: '0 4px' }}>⠿</span>
              {([['inspect', '⌖ Inspect'], ['arrow', '↗ Arrow'], ['pen', '✎ Draw'], ['rect', '▭ Box'], ['region', '⬚ Area']] as [Tool, string][]).map(([t, label]) => (
                <button key={t} onClick={() => setTool(t)} style={toolBtn(tool === t)}>{label}</button>
              ))}
              <button onClick={() => setRecording(true)} title="Record clicks / inputs / navigation across screens" style={{ ...toolBtn(false), borderColor: ACCENT }}>● Record</button>
              <button onClick={undo} title="Undo" style={{ ...toolBtn(false), marginLeft: 'auto' }}>↩</button>
              <button onClick={close} title="Close (Esc)" style={toolBtn(false)}>✕</button>
            </div>
            <div style={{ padding: 10, display: 'flex', gap: 10, alignItems: 'flex-start' }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && f.type.startsWith('image/')) readImage(f); }}>
              <textarea value={comment} onChange={(e) => setComment(e.target.value)}
                placeholder="What's wrong? Inspect elements, draw anywhere, snip an Area, or Record a flow — then Save."
                style={{ flex: 1, minHeight: 52, resize: 'vertical', borderRadius: 8, border: '1px solid #3a3a40', background: '#1a1a1e', color: '#fff', padding: 8, fontSize: 12, boxSizing: 'border-box', outline: 'none' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 128 }}>
                {region && regionShot ? (
                  <div style={{ position: 'relative' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={regionShot} alt="area snip" style={{ width: '100%', height: 40, objectFit: 'cover', borderRadius: 6, border: `1px solid ${ACCENT}` }} />
                    <button onClick={() => { setRegion(null); setRegionShot(null); }} style={badgeX}>×</button>
                  </div>
                ) : referenceImage ? (
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
            <div style={{ padding: '0 10px 8px', fontSize: 10, opacity: 0.6 }}>
              {targets.length} element{targets.length === 1 ? '' : 's'} · {shapes.length} annotation{shapes.length === 1 ? '' : 's'} · {actions.length} action{actions.length === 1 ? '' : 's'} · {region ? 'area snip' : 'full-page'} screenshot
            </div>
          </div>
        </>
      )}

      {toast && (
        <div data-nitpick-ui style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', padding: '8px 14px', borderRadius: 999, fontSize: 13, color: '#fff', background: 'rgba(20,20,22,0.95)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
          {toast}
        </div>
      )}
    </div>
  );

  return createPortal(content, document.body);
}

function toolBtn(active: boolean): React.CSSProperties {
  return {
    fontSize: 11, fontWeight: 600, padding: '5px 8px', borderRadius: 7, cursor: 'pointer',
    border: `1px solid ${active ? ACCENT : '#3a3a40'}`, background: active ? 'rgba(255,45,85,0.20)' : '#1a1a1e', color: '#fff', whiteSpace: 'nowrap',
  };
}
const badgeX: React.CSSProperties = { position: 'absolute', top: -8, right: -8, width: 18, height: 18, borderRadius: 9, border: 'none', background: ACCENT, color: '#fff', fontSize: 11, cursor: 'pointer', padding: 0 };
