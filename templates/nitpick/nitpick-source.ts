/**
 * Nitpick — click-to-source resolver.
 *
 * Maps a clicked DOM element to its source location + React component context, using a
 * layered, version-tolerant strategy (see DESIGN.md "Source-line resolution"):
 *
 *   1. `data-nitpick-src` build-time stamp  (most reliable; opt-in Babel plugin)
 *   2. React Fiber `_debugSource`            (zero-config on React <= 18 / Next <= 14)
 *   3. Component name + stack + selector      (every React version)
 *
 * This module NEVER throws. Anything it can't determine is returned as null/empty so the
 * overlay and the agent can degrade gracefully.
 */

export interface SourceLoc {
  file: string;
  line: number;
  column: number;
}

export interface ElementInfo {
  source: SourceLoc | null;
  componentName: string | null;
  componentStack: string[];
}

// React attaches the fiber under an own-enumerable key like "__reactFiber$abc123".
function getFiber(node: Node): any | null {
  const key = Object.keys(node).find(
    (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
  );
  return key ? (node as any)[key] : null;
}

function componentNameFromType(type: any): string | null {
  if (!type) return null;
  if (typeof type === 'string') return null; // host element (div, span, ...)
  // function/class components, forwardRef, memo wrappers
  return (
    type.displayName ||
    type.name ||
    (type.render && (type.render.displayName || type.render.name)) ||
    (type.type && (type.type.displayName || type.type.name)) ||
    null
  );
}

function parseDataSrc(value: string | null | undefined): SourceLoc | null {
  if (!value) return null;
  const m = value.match(/^(.*):(\d+):(\d+)$/);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
}

export function resolveElementInfo(node: Element): ElementInfo {
  const info: ElementInfo = { source: null, componentName: null, componentStack: [] };
  const el = node as HTMLElement;

  // 1. Build-time stamp — most reliable, version-proof.
  try {
    const stamped =
      el.getAttribute?.('data-nitpick-src') ||
      el.closest?.('[data-nitpick-src]')?.getAttribute('data-nitpick-src');
    info.source = parseDataSrc(stamped);
  } catch {
    /* ignore */
  }

  // 2 + 3. Walk the fiber tree: source (React <= 18) + component stack (all versions).
  try {
    let fiber = getFiber(node);
    const seen = new Set<any>();
    while (fiber && !seen.has(fiber)) {
      seen.add(fiber);

      if (!info.source && fiber._debugSource && fiber._debugSource.fileName) {
        const s = fiber._debugSource;
        if (typeof s.lineNumber === 'number') {
          info.source = {
            file: s.fileName,
            line: s.lineNumber,
            column: typeof s.columnNumber === 'number' ? s.columnNumber : 0,
          };
        }
      }

      const name =
        componentNameFromType(fiber.type) || componentNameFromType(fiber.elementType);
      if (name && info.componentStack[info.componentStack.length - 1] !== name) {
        info.componentStack.push(name);
      }

      fiber = fiber.return;
    }
  } catch {
    /* ignore */
  }

  if (info.source) info.source.file = relativizeSource(info.source.file);
  info.componentName = info.componentStack[0] || null;
  return info;
}

/** Normalize a build/runtime source path to a readable, repo-relative-ish path. */
export function relativizeSource(file: string): string {
  let f = file;
  f = f.replace(/^webpack-internal:\/\/\//, '');
  f = f.replace(/^\((?:app-pages-browser|app|pages|rsc)\)\//, '');
  f = f.replace(/^\.\//, '');
  // Absolute filesystem path -> keep from a recognizable source directory onward.
  const m = f.match(/(?:^|\/)((?:app|src|components|pages|lib|features|ui|widgets)\/.*)$/);
  if (m) f = m[1];
  return f;
}
