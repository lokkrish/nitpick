/**
 * Nitpick — optional build-time source stamp (Babel plugin).
 *
 * Stamps every JSX element with `data-nitpick-src="relative/path.tsx:line:col"` in
 * development only. This makes click-to-source EXACT and version-proof — the recommended path
 * for React 19 / Next 15+, where the runtime fiber `_debugSource` is no longer available.
 *
 * OPT-IN, because adding a Babel config to a Next.js app opts it out of the faster SWC
 * compiler. Only enable this if you want exact line numbers on React 19+. To enable, create a
 * `.babelrc` (or babel.config.js) in your project root:
 *
 *   {
 *     "presets": ["next/babel"],
 *     "plugins": ["<path-to>/babel-plugin-nitpick.js"]
 *   }
 *
 * `/nitpick:setup` will offer to do this for you.
 */
const path = require('path');

module.exports = function nitpickSourceStamp() {
  return {
    name: 'nitpick-source-stamp',
    visitor: {
      JSXOpeningElement(nodePath, state) {
        if (process.env.NODE_ENV === 'production') return;

        const node = nodePath.node;
        // Only stamp simple host/component elements (skip <></> and member expressions).
        if (!node.name || node.name.type !== 'JSXIdentifier') return;
        if (!node.loc) return;

        // Don't double-stamp.
        const already = node.attributes.some(
          (a) => a.type === 'JSXAttribute' && a.name && a.name.name === 'data-nitpick-src',
        );
        if (already) return;

        const filename = (state.file && state.file.opts && state.file.opts.filename) || '';
        const rel = filename
          ? path.relative(process.cwd(), filename).split(path.sep).join('/')
          : 'unknown';
        const value = `${rel}:${node.loc.start.line}:${node.loc.start.column}`;

        const t = state.types || require('@babel/types');
        node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier('data-nitpick-src'), t.stringLiteral(value)),
        );
      },
    },
  };
};
