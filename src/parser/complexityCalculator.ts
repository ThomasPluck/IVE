import type Parser from 'web-tree-sitter';
import { getLanguageConfig } from './languages.js';
import { findNodeAtRange } from './astUtils.js';
import type { SymbolRow } from '../indexer/database.js';

export interface SymbolMetrics {
  symbolId: number;
  cyclomatic: number;
  cognitive: number;
  paramCount: number;
  maxLoopDepth: number;
}

/**
 * Compute cyclomatic complexity, cognitive complexity, and parameter count
 * for each callable symbol in a file.
 */
export function computeMetrics(
  tree: Parser.Tree,
  language: string,
  symbols: SymbolRow[]
): SymbolMetrics[] {
  const config = getLanguageConfig(language);
  if (!config) return [];

  const callableSymbols = symbols.filter(s =>
    s.kind === 'function' || s.kind === 'method'
  );

  const decisionSet = new Set(config.decisionNodeTypes);
  const loopSet = new Set(config.loopNodeTypes);
  const results: SymbolMetrics[] = [];

  for (const sym of callableSymbols) {
    const symNode = findNodeAtRange(tree.rootNode, sym.startLine - 1, sym.endLine - 1);
    if (!symNode) {
      results.push({ symbolId: sym.id, cyclomatic: 1, cognitive: 0, paramCount: 0, maxLoopDepth: 0 });
      continue;
    }

    const decisionCount = countDecisionPoints(symNode, decisionSet);
    const cyclomatic = 1 + decisionCount;
    const cognitive = computeCognitive(symNode, decisionSet, 0);
    const paramCount = countParameters(symNode, config.parameterListField);
    const maxLoopDepth = maxNestingDepth(symNode, loopSet, 0);

    results.push({ symbolId: sym.id, cyclomatic, cognitive, paramCount, maxLoopDepth });
  }

  return results;
}

const LOGICAL_OPS = new Set(['&&', '||', 'and', 'or']);
const BINARY_DECISION_TYPES = new Set(['binary_expression', 'boolean_operator']);

/** Returns true if this decision node should count (filters binary_expression to logical ops only). */
function isCountableDecision(node: Parser.SyntaxNode): boolean {
  if (!BINARY_DECISION_TYPES.has(node.type)) return true;
  const op = node.childForFieldName('operator') ?? node.child(1);
  return op !== null && LOGICAL_OPS.has(op.text);
}

function countDecisionPoints(node: Parser.SyntaxNode, decisionTypes: Set<string>): number {
  let count = 0;

  function visit(n: Parser.SyntaxNode): void {
    if (decisionTypes.has(n.type) && isCountableDecision(n)) {
      count++;
    }
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) visit(child);
    }
  }

  visit(node);
  return count;
}

const NESTING_INCREASERS = new Set([
  'if_statement', 'for_statement', 'for_in_statement', 'while_statement',
  'do_statement', 'switch_statement', 'catch_clause',
  'function_declaration', 'arrow_function', 'function_definition',
]);

function computeCognitive(
  node: Parser.SyntaxNode,
  decisionTypes: Set<string>,
  nestingLevel: number
): number {
  let score = 0;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (decisionTypes.has(child.type) && isCountableDecision(child)) {
      score += BINARY_DECISION_TYPES.has(child.type) ? 1 : 1 + nestingLevel;
    }

    const newNesting = NESTING_INCREASERS.has(child.type) ? nestingLevel + 1 : nestingLevel;
    score += computeCognitive(child, decisionTypes, newNesting);
  }

  return score;
}

function countParameters(node: Parser.SyntaxNode, paramListField: string): number {
  const params = node.childForFieldName(paramListField);
  if (!params) return 0;
  let count = 0;
  for (let i = 0; i < params.childCount; i++) {
    const child = params.child(i);
    if (!child) continue;
    if (
      child.type === 'identifier' ||
      child.type === 'required_parameter' ||
      child.type === 'optional_parameter' ||
      child.type === 'typed_parameter' ||
      child.type === 'typed_default_parameter' ||
      child.type === 'default_parameter'
    ) {
      count++;
    }
  }
  return count;
}

function maxNestingDepth(node: Parser.SyntaxNode, loopTypes: Set<string>, currentDepth: number): number {
  const depth = loopTypes.has(node.type) ? currentDepth + 1 : currentDepth;
  let max = depth;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      const childMax = maxNestingDepth(child, loopTypes, depth);
      if (childMax > max) max = childMax;
    }
  }
  return max;
}
