'use client';

/**
 * Nitpick — in-app visual feedback overlay (dev-only).
 *
 * Press Ctrl+Shift+. to enter pick mode (configurable via the `hotkey` prop). Hover to inspect,
 * click to select an element, then
 * circle/arrow/draw on it, type a comment, optionally paste a reference image, and submit.
 * The report is POSTed to /api/nitpick, which writes it to `.nitpick/` for Claude to fix.
 *
 * Self-contained: only depends on React and ./nitpick-source. Screenshots are best-effort via
 * an optional dynamic import of `html-to-image` — if it's not installed, the report is still
 * saved with full metadata and vector annotations.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveElementInfo, type ElementInfo } from './nitpick-source';

const ACCENT = '#ff2d55';
const Z = 2147483600; // just below max, above app chrome
const ENDPOINT = '/api/nitpick';

/**
 * Activation hotkey. Matched on `event.code` (physical key) so it's independent of keyboard
 * layout and of any character transform from Alt/Option. Default Ctrl+Shift+Period avoids the
 * browser/OS shortcuts that plague Cmd/Ctrl + letter combos (notably Cmd+Shift+Q = Log Out on
 * macOS). Override per-app: <NitpickOverlay hotkey={{ alt: true, shift: true, code: 'KeyN' }} />.
 * `code` examples: 'Period', 'Slash', 'Backquote', 'KeyN', 'Digit0'.
 */
export interface Hotkey {
  ctrl?: boolean;
  meta?: boolean; // Cmd on macOS / Win key
  alt?: boolean; // Option on macOS
  shift?: boolean;
  code: string;
}
const DEFAULT_HOTKEY: Hotkey = { ctrl: true, shift: true, code: 'Period' };

function matchHotkey(e: KeyboardEvent, h: Hotkey): boolean {
  return (
    e.code === h.code &&
    e.ctrlKey === !!h.ctrl &&
    e.metaKey === !!h.meta &&
    e.altKey === !!h.alt &&
    e.shiftKey === !!h.shift
  );
}

function hotkeyLabel(h: Hotkey): string {
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');
  const key = h.code.startsWith('Key')
    ? h.code.slice(3)
    : h.code.startsWith('Digit')
      ? h.code.slice(5)
      : ({ Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Backquote: '`', Quote: "'" } as Record<string, string>)[h.code] || h.code;
  const parts: string[] = [];
  if (h.ctrl) parts.push('Ctrl');
  if (h.meta) parts.push(isMac ? 'Cmd' : 'Win');
  if (h.alt) parts.push(isMac ? 'Option' : 'Alt');
  if (h.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

type Tool = 'circle' | 'arrow' | 'pen';
type Mode = 'idle' | 'picking' | 'annotating';

type Annotation =
  | { type: 'circle'; cx: number; cy: number; rx: number; ry: number }
  | { type: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'pen'; points: [number, number][] };

interface Selected {
  el: Element;
  rect: DOMRect;
  info: ElementInfo;
}

// ---------------------------------------------------------------------------- helpers

const STYLE_KEYS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderRadius', 'borderTopWidth', 'borderColor', 'boxShadow',
  'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily',
  'lineHeight', 'letterSpacing', 'textAlign', 'textTransform',
  'flexDirection', 'justifyContent', 'alignItems', 'flexWrap', 'gap',
  'gridTemplateColumns', 'gridTemplateRows',
  'zIndex', 'opacity', 'overflow', 'transform', 'whiteSpace',
];

function kebab(s: string) {
  return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

function getStyleSubset(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const k of STYLE_KEYS) {
    const v = cs.getPropertyValue(kebab(k));
    if (v && v.trim() !== '') out[k] = v.trim();
  }
  return out;
}

function buildSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
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

function gatherElementMeta(el: Element, info: ElementInfo, rect: DOMRect) {
  const dataAttributes: Record<string, string> = {};
  const ds = (el as HTMLElement).dataset || {};
  for (const k of Object.keys(ds)) {
    if (k.startsWith('nitpick')) continue;
    dataAttributes[k] = ds[k] as string;
  }
  return {
    source: info.source,
    componentName: info.componentName,
    componentStack: info.componentStack,
    selector: buildSelector(el),
    tag: el.tagName.toLowerCase(),
    id: (el as HTMLElement).id || '',
    classes: Array.from(el.classList || []),
    text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140),
    dataAttributes,
    boundingBox: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    computedStyles: getStyleSubset(el),
  };
}

function drawAnnotations(ctx: CanvasRenderingContext2D, anns: Annotation[], w: number, h: number) {
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) * 0.006));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const a of anns) {
    ctx.beginPath();
    if (a.type === 'circle') {
      ctx.ellipse(a.cx * w, a.cy * h, Math.abs(a.rx) * w, Math.abs(a.ry) * h, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (a.type === 'arrow') {
      const x1 = a.x1 * w, y1 = a.y1 * h, x2 = a.x2 * w, y2 = a.y2 * h;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = ctx.lineWidth * 4;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    } else if (a.type === 'pen') {
      a.points.forEach(([px, py], i) => {
        const X = px * w, Y = py * h;
        if (i === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      });
      ctx.stroke();
    }
  }
}

async function captureScreenshot(el: Element, anns: Annotation[]): Promise<string | null> {
  try {
    // Screenshot dependency — `/nitpick:setup` installs it (npm i -D html-to-image).
    // Bundled normally; if the call fails at runtime we fall back to no screenshot.
    const mod: any = await import('html-to-image').catch(() => null);
    if (!mod || !mod.toPng) return null;
    const dpr = window.devicePixelRatio || 1;
    const dataUrl: string = await mod.toPng(el as HTMLElement, {
      pixelRatio: dpr,
      cacheBust: true,
      filter: (n: any) => !(n && n.dataset && n.dataset.nitpickUi),
    });
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = rej;
      img.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0);
    if (anns.length) drawAnnotations(ctx, anns, img.width, img.height);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function labelFor(el: Element, info: ElementInfo): string {
  const name = info.componentName ? `<${info.componentName}>` : `<${el.tagName.toLowerCase()}>`;
  if (info.source) return `${name}  ·  ${info.source.file}:${info.source.line}`;
  return name;
}

// ---------------------------------------------------------------------------- component

export default function NitpickOverlay({ hotkey }: { hotkey?: Hotkey } = {}) {
  // No hooks here: keeps rules-of-hooks happy while fully excluding prod.
  if (process.env.NODE_ENV === 'production') return null;
  return <NitpickOverlayInner hotkey={hotkey ?? DEFAULT_HOTKEY} />;
}

function NitpickOverlayInner({ hotkey }: { hotkey: Hotkey }) {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<Mode>('idle');
  const [hovered, setHovered] = useState<{ rect: DOMRect; label: string } | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [tool, setTool] = useState<Tool>('circle');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [comment, setComment] = useState('');
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const reset = useCallback(() => {
    setMode('idle');
    setHovered(null);
    setSelected(null);
    setAnnotations([]);
    setDraft(null);
    setComment('');
    setReferenceImage(null);
    drawStart.current = null;
  }, []);

  useEffect(() => {
    setMounted(true);
    // One-time readiness hint so you can confirm the overlay loaded.
    // eslint-disable-next-line no-console
    console.info(
      `[Nitpick] ready — press ${hotkeyLabel(hotkey)} or double-tap Shift, or click the badge (bottom-right).`,
    );
  }, [hotkey]);

  // Activation. Three ways in, so at least one always works regardless of OS/browser shortcuts:
  //   1. the configured combo (default Ctrl+Shift+.),
  //   2. double-tap Shift (rarely intercepted by anything),
  //   3. the clickable badge (rendered below).
  // Activation only ENTERS pick mode or exits from picking — it never fires while annotating,
  // so it can't discard an in-progress report. Esc / Cancel exit annotation mode.
  useEffect(() => {
    let lastShiftUp = 0;
    const toggle = () =>
      setMode((m) => (m === 'idle' ? 'picking' : m === 'picking' ? 'idle' : m));

    const onKeyDown = (e: KeyboardEvent) => {
      if (matchHotkey(e, hotkey)) {
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key === 'Escape' && mode !== 'idle') {
        e.preventDefault();
        reset();
        return;
      }
      // Any non-Shift key cancels an in-progress double-tap.
      if (e.key !== 'Shift') lastShiftUp = 0;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return;
      const now = Date.now();
      if (now - lastShiftUp > 40 && now - lastShiftUp < 450) {
        lastShiftUp = 0;
        if (mode === 'idle') setMode('picking'); // double-tap only enters, never discards work
      } else {
        lastShiftUp = now;
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [mode, reset, hotkey]);

  // Pick mode: inspect on hover, freeze on click.
  useEffect(() => {
    if (mode !== 'picking') return;
    const elementUnder = (x: number, y: number): Element | null => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      if ((el as HTMLElement).closest?.('[data-nitpick-ui]')) return null;
      if (el === document.documentElement || el === document.body) return null;
      return el;
    };
    const onMove = (e: MouseEvent) => {
      const el = elementUnder(e.clientX, e.clientY);
      if (!el) return setHovered(null);
      setHovered({ rect: el.getBoundingClientRect(), label: labelFor(el, resolveElementInfo(el)) });
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = elementUnder(e.clientX, e.clientY);
      if (!el) return;
      setSelected({ el, rect: el.getBoundingClientRect(), info: resolveElementInfo(el) });
      setHovered(null);
      setMode('annotating');
    };
    const block = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
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
  }, [mode]);

  // Lock scroll + accept pasted reference images while annotating.
  useEffect(() => {
    if (mode !== 'annotating') return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (file) {
            readImage(file);
            e.preventDefault();
          }
        }
      }
    };
    window.addEventListener('paste', onPaste, true);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('paste', onPaste, true);
    };
  }, [mode]);

  const readImage = useCallback((file: File) => {
    const r = new FileReader();
    r.onload = () => setReferenceImage(typeof r.result === 'string' ? r.result : null);
    r.readAsDataURL(file);
  }, []);

  // ---- drawing (coords normalized to the selected element's rect) ----
  const toNorm = useCallback(
    (clientX: number, clientY: number) => {
      const r = selected!.rect;
      return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
    },
    [selected],
  );
  const toPx = useCallback(
    (nx: number, ny: number) => {
      const r = selected!.rect;
      return { x: r.left + nx * r.width, y: r.top + ny * r.height };
    },
    [selected],
  );

  const onDrawStart = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const n = toNorm(e.clientX, e.clientY);
    drawStart.current = n;
    if (tool === 'pen') setDraft({ type: 'pen', points: [[n.x, n.y]] });
    else if (tool === 'circle') setDraft({ type: 'circle', cx: n.x, cy: n.y, rx: 0, ry: 0 });
    else setDraft({ type: 'arrow', x1: n.x, y1: n.y, x2: n.x, y2: n.y });
  };
  const onDrawMove = (e: React.PointerEvent) => {
    const s = drawStart.current;
    if (!s) return;
    const n = toNorm(e.clientX, e.clientY);
    if (tool === 'pen') {
      setDraft((d) => (d && d.type === 'pen' ? { type: 'pen', points: [...d.points, [n.x, n.y]] } : d));
    } else if (tool === 'circle') {
      setDraft({ type: 'circle', cx: (s.x + n.x) / 2, cy: (s.y + n.y) / 2, rx: Math.abs(n.x - s.x) / 2, ry: Math.abs(n.y - s.y) / 2 });
    } else {
      setDraft({ type: 'arrow', x1: s.x, y1: s.y, x2: n.x, y2: n.y });
    }
  };
  const onDrawEnd = () => {
    if (draft) setAnnotations((a) => [...a, draft]);
    setDraft(null);
    drawStart.current = null;
  };

  const submit = useCallback(async () => {
    if (!selected) return;
    setSubmitting(true);
    const { el, rect, info } = selected;
    const screenshot = await captureScreenshot(el, annotations);
    const payload = {
      comment,
      route: window.location.pathname + window.location.search,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      element: gatherElementMeta(el, info, rect),
      annotations,
      screenshot,
      referenceImage,
    };
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      reset();
      showToast(res.ok ? `📍 Saved feedback #${data.id ?? ''}` : `Save failed (${res.status})`);
    } catch {
      setSubmitting(false);
      showToast('Save failed — is the dev server running?');
      return;
    }
    setSubmitting(false);
  }, [selected, annotations, comment, referenceImage, reset, showToast]);

  if (!mounted) return null;

  const renderAnnotation = (a: Annotation, key: number) => {
    if (a.type === 'circle') {
      const c = toPx(a.cx, a.cy);
      const r = selected!.rect;
      return <ellipse key={key} cx={c.x} cy={c.y} rx={Math.abs(a.rx) * r.width} ry={Math.abs(a.ry) * r.height} fill="none" stroke={ACCENT} strokeWidth={3} />;
    }
    if (a.type === 'arrow') {
      const p1 = toPx(a.x1, a.y1);
      const p2 = toPx(a.x2, a.y2);
      return <line key={key} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={ACCENT} strokeWidth={3} markerEnd="url(#pp-arrow)" />;
    }
    const d = a.points.map(([x, y], i) => {
      const p = toPx(x, y);
      return `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`;
    }).join(' ');
    return <path key={key} d={d} fill="none" stroke={ACCENT} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />;
  };

  const content = (
    <div data-nitpick-ui="root" style={{ position: 'fixed', inset: 0, zIndex: Z, pointerEvents: 'none', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      {/* IDLE: clickable launcher (also shows the keyboard shortcut) */}
      {mode === 'idle' && (
        <button
          data-nitpick-ui
          onClick={() => setMode('picking')}
          title={`Activate Nitpick — ${hotkeyLabel(hotkey)} or double-tap Shift, then click an element to report a UI issue`}
          style={{ position: 'fixed', bottom: 12, right: 12, padding: '7px 11px', borderRadius: 8, fontSize: 11, color: '#fff', background: 'rgba(20,20,22,0.82)', boxShadow: '0 2px 10px rgba(0,0,0,0.3)', border: 'none', cursor: 'pointer', pointerEvents: 'auto', fontFamily: 'inherit' }}
        >
          📍 Nitpick · <b>{hotkeyLabel(hotkey)}</b>
        </button>
      )}

      {/* PICKING: hover highlight + crosshair label */}
      {mode === 'picking' && (
        <>
          <div data-nitpick-ui style={{ position: 'fixed', inset: 0, background: 'rgba(80,90,255,0.04)' }} />
          {hovered && (
            <>
              <div data-nitpick-ui style={{ position: 'fixed', left: hovered.rect.left, top: hovered.rect.top, width: hovered.rect.width, height: hovered.rect.height, outline: `2px solid ${ACCENT}`, background: 'rgba(255,45,85,0.10)', borderRadius: 2, transition: 'all 40ms linear' }} />
              <div data-nitpick-ui style={{ position: 'fixed', left: Math.max(8, hovered.rect.left), top: Math.max(8, hovered.rect.top - 26), maxWidth: '90vw', padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#fff', background: ACCENT }}>
                {hovered.label}
              </div>
            </>
          )}
          <div data-nitpick-ui style={{ position: 'fixed', top: 14, left: '50%', transform: 'translateX(-50%)', padding: '8px 14px', borderRadius: 999, fontSize: 13, color: '#fff', background: 'rgba(20,20,22,0.9)', boxShadow: '0 4px 20px rgba(0,0,0,0.35)' }}>
            🎯 Click the element with the issue &nbsp;·&nbsp; <b>Esc</b> to cancel
          </div>
        </>
      )}

      {/* ANNOTATING: backdrop, element outline, draw surface, panel */}
      {mode === 'annotating' && selected && (
        <>
          <div data-nitpick-ui style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,14,0.45)' }} />
          <div data-nitpick-ui style={{ position: 'fixed', left: selected.rect.left - 2, top: selected.rect.top - 2, width: selected.rect.width + 4, height: selected.rect.height + 4, outline: `2px solid ${ACCENT}`, boxShadow: '0 0 0 9999px rgba(10,10,14,0.0)', borderRadius: 3 }} />
          <svg
            data-nitpick-ui
            width="100%"
            height="100%"
            style={{ position: 'fixed', inset: 0, pointerEvents: 'auto', cursor: 'crosshair' }}
            onPointerDown={onDrawStart}
            onPointerMove={onDrawMove}
            onPointerUp={onDrawEnd}
          >
            <defs>
              <marker id="pp-arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L7,3 L0,6 Z" fill={ACCENT} />
              </marker>
            </defs>
            {annotations.map(renderAnnotation)}
            {draft && renderAnnotation(draft, -1)}
          </svg>

          <div
            data-nitpick-ui
            style={{ position: 'fixed', right: 16, bottom: 16, width: 320, maxWidth: '92vw', pointerEvents: 'auto', background: 'rgba(24,24,28,0.97)', color: '#fff', borderRadius: 14, padding: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', backdropFilter: 'blur(6px)' }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f && f.type.startsWith('image/')) readImage(f);
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>📍 Report UI issue</span>
              <span style={{ fontSize: 11, opacity: 0.6, maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected.info.componentName ? `<${selected.info.componentName}>` : selected.el.tagName.toLowerCase()}
                {selected.info.source ? ` · ${selected.info.source.file}:${selected.info.source.line}` : ''}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {(['circle', 'arrow', 'pen'] as Tool[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTool(t)}
                  style={toolBtn(tool === t)}
                >
                  {t === 'circle' ? '◯ Circle' : t === 'arrow' ? '↗ Arrow' : '✎ Draw'}
                </button>
              ))}
              <button onClick={() => setAnnotations((a) => a.slice(0, -1))} disabled={!annotations.length} style={{ ...toolBtn(false), marginLeft: 'auto', opacity: annotations.length ? 1 : 0.4 }}>
                ↩ Undo
              </button>
            </div>

            <textarea
              autoFocus
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onPaste={(e) => {
                const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
                const f = item?.getAsFile();
                if (f) {
                  readImage(f);
                  e.preventDefault();
                }
              }}
              placeholder="What's wrong? (e.g. padding too tight on mobile; should match the reference)"
              style={{ width: '100%', minHeight: 64, resize: 'vertical', borderRadius: 8, border: '1px solid #3a3a40', background: '#1a1a1e', color: '#fff', padding: 8, fontSize: 12, boxSizing: 'border-box', outline: 'none' }}
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
              {referenceImage ? (
                <div style={{ position: 'relative' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={referenceImage} alt="reference" style={{ height: 44, borderRadius: 6, border: '1px solid #3a3a40' }} />
                  <button onClick={() => setReferenceImage(null)} style={{ position: 'absolute', top: -8, right: -8, width: 18, height: 18, borderRadius: 9, border: 'none', background: ACCENT, color: '#fff', fontSize: 11, cursor: 'pointer', lineHeight: '18px', padding: 0 }}>×</button>
                </div>
              ) : (
                <label style={{ fontSize: 11, opacity: 0.7, cursor: 'pointer', padding: '6px 8px', border: '1px dashed #3a3a40', borderRadius: 8 }}>
                  ＋ Reference image (paste / drop / pick)
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) readImage(f); }} />
                </label>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={reset} style={{ ...toolBtn(false), flex: '0 0 auto' }}>Cancel</button>
              <button
                onClick={submit}
                disabled={submitting}
                style={{ flex: 1, borderRadius: 8, border: 'none', background: ACCENT, color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 10px', cursor: submitting ? 'default' : 'pointer', opacity: submitting ? 0.7 : 1 }}
              >
                {submitting ? 'Saving…' : 'Save feedback'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* toast */}
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
    fontSize: 11,
    fontWeight: 600,
    padding: '6px 9px',
    borderRadius: 8,
    cursor: 'pointer',
    border: `1px solid ${active ? ACCENT : '#3a3a40'}`,
    background: active ? 'rgba(255,45,85,0.18)' : '#1a1a1e',
    color: '#fff',
  };
}
