import type Parser from 'web-tree-sitter';

/**
 * Find the deepest AST node whose range fully contains [startRow, endRow].
 * Used to locate the AST node for a symbol given its line range.
 */
export function findNodeAtRange(
  node: Parser.SyntaxNode,
  startRow: number,
  endRow: number
): Parser.SyntaxNode | null {
  if (node.startPosition.row > startRow || node.endPosition.row < endRow) {
    return null;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const found = findNodeAtRange(child, startRow, endRow);
    if (found) return found;
  }

  return node;
}
