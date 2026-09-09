import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JavaScriptLanguageIndexer } from '../../server/adapters/language-indexers/javascript.js';
import { LanguageIndexerRegistry } from '../../server/adapters/language-indexers/registry.js';

test('JavaScript indexer extracts declarations and local module imports', () => {
  const indexer = new JavaScriptLanguageIndexer();
  const source = [
    "import provider, { load as fetchLoad, stream } from './provider.js';",
    "import * as helpers from './helpers.js';",
    "const legacy = require('./legacy.cjs');",
    'export async function start() {}',
    'export class Provider {}',
    'export const capability = true, cancellation = false;',
    'function localHelper() {}',
    'const execute = () => {};',
    'export default function draftTimeline() {}'
  ].join('\n');

  const result = indexer.parse({ path: 'src/adapter.js', content: source });

  assert.deepEqual(result.symbols, [
    { name: 'legacy', kind: 'variable', line: 3, exported: false },
    { name: 'start', kind: 'function', line: 4, exported: true },
    { name: 'Provider', kind: 'class', line: 5, exported: true },
    { name: 'capability', kind: 'variable', line: 6, exported: true },
    { name: 'cancellation', kind: 'variable', line: 6, exported: true },
    { name: 'localHelper', kind: 'function', line: 7, exported: false },
    { name: 'execute', kind: 'variable', line: 8, exported: false },
    { name: 'draftTimeline', kind: 'function', line: 9, exported: true }
  ]);
  assert.deepEqual(result.imports, [
    {
      specifier: './provider.js',
      kind: 'esm',
      line: 1,
      names: [
        { imported: 'default', local: 'provider' },
        { imported: 'load', local: 'fetchLoad' },
        { imported: 'stream', local: 'stream' }
      ]
    },
    {
      specifier: './helpers.js',
      kind: 'esm',
      line: 2,
      names: [{ imported: '*', local: 'helpers' }]
    },
    {
      specifier: './legacy.cjs',
      kind: 'commonjs',
      line: 3,
      names: [{ imported: 'default', local: 'legacy' }]
    }
  ]);
});

test('JavaScript indexer ignores declaration-like text in comments, strings, and templates', () => {
  const indexer = new JavaScriptLanguageIndexer();
  const result = indexer.parse({
    path: 'src/real.mjs',
    content: [
      '// export function commented() {}',
      'const message = "class StringOnly {}";',
      'const template = `import ghost from "./ghost.js"`;',
      '/* const hidden = require("./hidden.js"); */',
      'export function real() {}'
    ].join('\n')
  });

  assert.deepEqual(result.symbols, [
    { name: 'message', kind: 'variable', line: 2, exported: false },
    { name: 'template', kind: 'variable', line: 3, exported: false },
    { name: 'real', kind: 'function', line: 5, exported: true }
  ]);
  assert.deepEqual(result.imports, []);
});

test('language indexer registry supports JavaScript-family files and degrades gracefully', () => {
  const registry = new LanguageIndexerRegistry();

  assert.equal(registry.supports('src/view.tsx'), true);
  assert.equal(registry.supports('docs/architecture.md'), false);
  assert.deepEqual(registry.parse({ path: 'docs/architecture.md', content: '# Architecture' }), {
    symbols: [],
    imports: [],
    language: null
  });
  assert.equal(registry.parse({ path: 'src/view.tsx', content: 'export class View {}' }).language, 'javascript');
});
