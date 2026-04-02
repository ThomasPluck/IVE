import type Parser from 'web-tree-sitter';
import { getLanguageConfig } from './languages.js';
import type { TreeNode } from '../types.js';

export interface ExtractedSymbol {
  name: string;
  kind: TreeNode['kind'];
  startLine: number;
  endLine: number;
  loc: number;
  children: ExtractedSymbol[];
}

export interface ImportBinding {
  localName: string;
  importedName: string;
  sourceModule: string;
}

export function extractSymbols(tree: Parser.Tree, language: string): ExtractedSymbol[] {
  const config = getLanguageConfig(language);
  if (!config) return [];

  const root = tree.rootNode;
  return extractFromNode(root, config.symbolNodeTypes, language);
}

function extractFromNode(
  node: Parser.SyntaxNode,
  symbolTypes: string[],
  language: string
): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (symbolTypes.includes(child.type)) {
      const symbol = nodeToSymbol(child, symbolTypes, language);
      if (symbol) {
        symbols.push(symbol);
      }
    } else {
      // Look for exported/variable declarations wrapping arrow functions
      if (child.type === 'export_statement' || child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
        const nested = extractFromExportOrVariable(child, symbolTypes, language);
        symbols.push(...nested);
      }
    }
  }

  return symbols;
}

function extractFromExportOrVariable(
  node: Parser.SyntaxNode,
  symbolTypes: string[],
  language: string
): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (symbolTypes.includes(child.type)) {
      const symbol = nodeToSymbol(child, symbolTypes, language);
      if (symbol) symbols.push(symbol);
    } else if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
      symbols.push(...extractFromExportOrVariable(child, symbolTypes, language));
    } else if (child.type === 'variable_declarator') {
      // const myFunc = () => { ... }
      const nameNode = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      if (nameNode && valueNode && valueNode.type === 'arrow_function') {
        symbols.push({
          name: nameNode.text,
          kind: 'function',
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          loc: child.endPosition.row - child.startPosition.row + 1,
          children: extractFromNode(valueNode, symbolTypes, language),
        });
      }
    }
  }

  return symbols;
}

function nodeToSymbol(
  node: Parser.SyntaxNode,
  symbolTypes: string[],
  language: string
): ExtractedSymbol | null {
  const name = getNodeName(node, language);
  if (!name) return null;

  const kind = getKind(node.type, language);
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  // Extract children (methods inside classes, etc.)
  const children: ExtractedSymbol[] = [];
  const body = node.childForFieldName('body');
  if (body) {
    children.push(...extractFromNode(body, symbolTypes, language));
  }

  return {
    name,
    kind,
    startLine,
    endLine,
    loc: endLine - startLine + 1,
    children,
  };
}

function getNodeName(node: Parser.SyntaxNode, language: string): string | null {
  // Try 'name' field first (works for most declarations)
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  // For method_definition, try 'name' directly
  if (node.type === 'method_definition') {
    const n = node.childForFieldName('name');
    return n?.text ?? null;
  }

  return null;
}

function getKind(nodeType: string, _language: string): TreeNode['kind'] {
  switch (nodeType) {
    case 'function_declaration':
    case 'function_definition':
    case 'arrow_function':
    case 'function_item':     // Rust
      return 'function';
    case 'class_declaration':
    case 'class_definition':
    case 'impl_item':         // Rust impl block
      return 'class';
    case 'method_definition':
    case 'method_declaration': // Go
      return 'method';
    case 'interface_declaration':
    case 'trait_item':        // Rust
      return 'interface';
    case 'type_alias_declaration':
    case 'type_declaration':  // Go
    case 'struct_item':       // Rust
      return 'type';
    case 'enum_declaration':
    case 'enum_item':         // Rust
      return 'enum';
    default:
      return 'function';
  }
}

/**
 * Extract import bindings from TS/TSX/JS import statements.
 * Maps local aliases to their original exported names.
 */
export function extractImports(tree: Parser.Tree, language: string): ImportBinding[] {
  if (!['typescript', 'tsx', 'javascript'].includes(language)) return [];

  const bindings: ImportBinding[] = [];
  const root = tree.rootNode;

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (!child) continue;

    // Handle: import { X, Y as Z } from 'module'
    // Also: export { X } from 'module' (re-exports)
    if (child.type === 'import_statement' || child.type === 'export_statement') {
      const source = child.childForFieldName('source');
      if (!source) continue;
      // Strip quotes from string literal
      const sourceModule = source.text.replace(/^['"]|['"]$/g, '');

      // Walk children to find import_clause or named_imports
      visitImportNode(child, sourceModule, bindings);
    }
  }

  return bindings;
}

function visitImportNode(node: Parser.SyntaxNode, sourceModule: string, bindings: ImportBinding[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === 'import_specifier' || child.type === 'export_specifier') {
      const nameNode = child.childForFieldName('name');
      const aliasNode = child.childForFieldName('alias');
      if (nameNode) {
        bindings.push({
          importedName: nameNode.text,
          localName: aliasNode?.text ?? nameNode.text,
          sourceModule,
        });
      }
    } else if (child.type === 'namespace_import') {
      // import * as ns from 'module' — can't resolve individual names
    } else {
      visitImportNode(child, sourceModule, bindings);
    }
  }
}

// ── Test block detection ────────────────────────────────────────────────────

const TEST_CALLEE_NAMES = new Set(['describe', 'it', 'test', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);

/**
 * Extract vitest/jest test blocks (describe/it/test) as symbols with kind 'test'.
 * Only runs for TS/TSX/JS files.
 */
export function extractTestBlocks(tree: Parser.Tree, language: string): ExtractedSymbol[] {
  if (!['typescript', 'tsx', 'javascript'].includes(language)) return [];

  const symbols: ExtractedSymbol[] = [];
  collectTestBlocks(tree.rootNode, symbols);
  return symbols;
}

function collectTestBlocks(node: Parser.SyntaxNode, symbols: ExtractedSymbol[]): void {
  if (node.type === 'call_expression') {
    const funcChild = node.childForFieldName('function') ?? node.child(0);
    if (funcChild && funcChild.type === 'identifier' && TEST_CALLEE_NAMES.has(funcChild.text)) {
      const args = node.childForFieldName('arguments');
      if (args && args.childCount >= 2) {
        // First arg: test name (string literal)
        const nameArg = args.child(1); // child(0) is '('
        // Second arg: callback
        const callbackArg = args.child(3); // child(2) is ','

        const name = nameArg && (nameArg.type === 'string' || nameArg.type === 'template_string')
          ? nameArg.text.replace(/^['"`]|['"`]$/g, '')
          : funcChild.text;

        const span = callbackArg ?? node;
        symbols.push({
          name: `${funcChild.text}: ${name}`,
          kind: 'test',
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          loc: node.endPosition.row - node.startPosition.row + 1,
          children: [],
        });
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectTestBlocks(child, symbols);
  }
}
