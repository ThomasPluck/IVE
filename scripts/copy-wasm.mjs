import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distGrammars = join(root, 'dist', 'grammars');

mkdirSync(distGrammars, { recursive: true });

// Copy tree-sitter core WASM
const treeSitterWasm = join(root, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
if (existsSync(treeSitterWasm)) {
  cpSync(treeSitterWasm, join(distGrammars, 'tree-sitter.wasm'));
  console.log('Copied tree-sitter.wasm');
}

// Copy language grammars from tree-sitter-wasms if available
const wasmsSrc = join(root, 'node_modules', 'tree-sitter-wasms', 'out');
const grammars = [
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-rust.wasm',
  'tree-sitter-go.wasm',
];

for (const grammar of grammars) {
  const src = join(wasmsSrc, grammar);
  if (existsSync(src)) {
    cpSync(src, join(distGrammars, grammar));
    console.log(`Copied ${grammar}`);
  } else {
    console.warn(`Warning: ${grammar} not found at ${src}`);
  }
}

// Copy sql.js WASM
const sqlWasm = join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const distRoot = join(root, 'dist');
mkdirSync(distRoot, { recursive: true });
if (existsSync(sqlWasm)) {
  cpSync(sqlWasm, join(distRoot, 'sql-wasm.wasm'));
  console.log('Copied sql-wasm.wasm');
}
