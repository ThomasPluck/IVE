/**
 * Minimal mock for Parser.SyntaxNode — lets complexity/symbol/callgraph
 * tests run without loading tree-sitter WASM.
 */
export interface MockNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition:   { row: number; column: number };
  childCount: number;
  children: MockNode[];
  child:              (i: number)    => MockNode | null;
  childForFieldName:  (name: string) => MockNode | null;
}

export function node(
  type: string,
  opts: {
    text?:     string;
    start?:    number;
    end?:      number;
    children?: MockNode[];
    fields?:   Record<string, MockNode>;
  } = {}
): MockNode {
  const ch = opts.children ?? [];
  return {
    type,
    text: opts.text ?? type,
    startPosition: { row: opts.start ?? 0, column: 0 },
    endPosition:   { row: opts.end   ?? 1, column: 0 },
    childCount: ch.length,
    children: ch,
    child:             (i) => ch[i] ?? null,
    childForFieldName: (n) => opts.fields?.[n] ?? null,
  };
}

/** Convenience: an identifier node whose text is `name` */
export function ident(name: string): MockNode {
  return node('identifier', { text: name, start: 0, end: 0 });
}

/**
 * Build a mock tree wrapping a function_declaration.
 * - bodyChildren are placed inside a statement_block (rows start+1..end-1)
 * - The function node spans start..end (default 0..20)
 * - findNodeAtRange will return the function_declaration for symbol rows (start, end)
 *   because the statement_block starts at start+1, which is > start, so it won't
 *   be chosen as a deeper match.
 */
export function mockTree(
  fnName: string,
  bodyChildren: MockNode[],
  opts: { start?: number; end?: number; params?: MockNode[] } = {}
): { rootNode: MockNode } {
  const start = opts.start ?? 0;
  const end   = opts.end   ?? 20;

  const paramNode = node('formal_parameters', {
    children: opts.params ?? [],
    start,
    end: start, // same row — won't cover the full symbol range
  });

  const bodyNode = node('statement_block', {
    children: bodyChildren,
    start: start + 1,
    end:   end - 1,
  });

  const nameNode = ident(fnName);
  const fnNode = node('function_declaration', {
    start,
    end,
    fields: {
      name:       nameNode,
      parameters: paramNode,
      body:       bodyNode,
    },
    children: [nameNode, paramNode, bodyNode],
  });

  return {
    rootNode: node('program', {
      children: [fnNode],
      start: 0,
      end: end + 1,
    }),
  };
}
