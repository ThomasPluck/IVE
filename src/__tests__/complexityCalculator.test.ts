import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../parser/complexityCalculator.js';
import { node, ident, mockTree } from './helpers/mockNode.js';
import type { SymbolRow } from '../indexer/database.js';

/** Minimal SymbolRow for a function at rows [start, end] (1-indexed lines). */
function sym(id: number, startLine: number, endLine: number): SymbolRow {
  return { id, name: 'fn', kind: 'function', fileId: 1, startLine, endLine, loc: endLine - startLine + 1, parentSymbolId: null };
}

describe('computeMetrics — TypeScript', () => {
  const LANG = 'typescript';

  it('empty function body → CC=1, cognitive=0, loopDepth=0, paramCount=0', () => {
    const tree = mockTree('myFn', [], { start: 0, end: 20 });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.cyclomatic).toBe(1);
    expect(m.cognitive).toBe(0);
    expect(m.maxLoopDepth).toBe(0);
    expect(m.paramCount).toBe(0);
  });

  it('one if_statement → CC=2, cognitive=1', () => {
    const ifNode = node('if_statement', { start: 2, end: 5 });
    const tree = mockTree('myFn', [ifNode], { start: 0, end: 20 });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.cyclomatic).toBe(2);
    expect(m.cognitive).toBe(1);
  });

  it('nested if_statement inside if_statement → CC=3, cognitive=3', () => {
    const inner = node('if_statement', { start: 3, end: 4 });
    const outer = node('if_statement', { start: 2, end: 5, children: [inner] });
    const tree = mockTree('myFn', [outer], { start: 0, end: 20 });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.cyclomatic).toBe(3);
    // outer: +1 at nestingLevel=0; inner: +(1+1) at nestingLevel=1
    expect(m.cognitive).toBe(3);
  });

  it('for_statement → CC=2, loopDepth=1', () => {
    const forNode = node('for_statement', { start: 2, end: 5 });
    const tree = mockTree('myFn', [forNode], { start: 0, end: 20 });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.cyclomatic).toBe(2);
    expect(m.maxLoopDepth).toBe(1);
  });

  it('while_statement nested inside for_statement → CC=3, loopDepth=2', () => {
    const whileNode = node('while_statement', { start: 3, end: 4 });
    const forNode   = node('for_statement', { start: 2, end: 5, children: [whileNode] });
    const tree = mockTree('myFn', [forNode], { start: 0, end: 20 });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.cyclomatic).toBe(3);
    expect(m.maxLoopDepth).toBe(2);
  });

  it('switch with 3 switch_case children → CC=4', () => {
    const cases = [
      node('switch_case', { start: 3, end: 4 }),
      node('switch_case', { start: 5, end: 6 }),
      node('switch_case', { start: 7, end: 8 }),
    ];
    const switchNode = node('switch_statement', { start: 2, end: 9, children: cases });
    const tree = mockTree('myFn', [switchNode], { start: 0, end: 20 });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.cyclomatic).toBe(4);
  });

  it('catch_clause → CC=2', () => {
    const catchNode = node('catch_clause', { start: 3, end: 5 });
    const tree = mockTree('myFn', [catchNode], { start: 0, end: 20 });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.cyclomatic).toBe(2);
  });

  it('binary_expression with && is NOT counted (not in TS decisionNodeTypes)', () => {
    // binary_expression not in TypeScript decisionNodeTypes, so CC stays 1
    const opNode = ident('&&');
    opNode.text = '&&';
    const binExpr = node('binary_expression', {
      start: 2, end: 2,
      fields: { operator: opNode },
      children: [ident('a'), opNode, ident('b')],
    });
    const tree = mockTree('myFn', [binExpr], { start: 0, end: 20 });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.cyclomatic).toBe(1);
  });

  it('3 required_parameter children → paramCount=3', () => {
    const params = [
      node('required_parameter', { start: 0, end: 0 }),
      node('required_parameter', { start: 0, end: 0 }),
      node('required_parameter', { start: 0, end: 0 }),
    ];
    const tree = mockTree('myFn', [], { start: 0, end: 20, params });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.paramCount).toBe(3);
  });

  it('symbol out of AST range → baseline metrics (CC=1, rest 0)', () => {
    const tree = mockTree('myFn', [], { start: 0, end: 5 });
    // Symbol spans rows 100..200 which are not in the tree at all
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 101, 201)]);
    expect(m.cyclomatic).toBe(1);
    expect(m.cognitive).toBe(0);
    expect(m.maxLoopDepth).toBe(0);
    expect(m.paramCount).toBe(0);
  });

  it('non-callable symbol (kind=class) → excluded from results', () => {
    const tree = mockTree('myFn', [], { start: 0, end: 20 });
    const classSym: SymbolRow = { id: 99, name: 'MyClass', kind: 'class', fileId: 1, startLine: 1, endLine: 21, loc: 21, parentSymbolId: null };
    const results = computeMetrics(tree as any, LANG, [classSym]);
    expect(results).toHaveLength(0);
  });

  it('unsupported language → returns empty array', () => {
    const tree = mockTree('myFn', [], { start: 0, end: 20 });
    const results = computeMetrics(tree as any, 'cobol', [sym(1, 1, 21)]);
    expect(results).toHaveLength(0);
  });

  it('conditional_expression (ternary) → CC=2', () => {
    const ternary = node('conditional_expression', { start: 2, end: 2 });
    const tree = mockTree('myFn', [ternary], { start: 0, end: 20 });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.cyclomatic).toBe(2);
  });

  it('multiple symbols in same file get independent metrics', () => {
    const ifNode = node('if_statement', { start: 2, end: 5 });
    const tree = mockTree('fn1', [ifNode], { start: 0, end: 20 });
    // Add a second function_declaration with no decision points
    const fn2Name = ident('fn2');
    const fn2Body = node('statement_block', { start: 26, end: 29 });
    const fn2 = node('function_declaration', {
      start: 25, end: 30,
      fields: { name: fn2Name, parameters: node('formal_parameters', { start: 25, end: 25 }), body: fn2Body },
      children: [fn2Name, fn2Body],
    });
    (tree.rootNode as any).children.push(fn2);
    (tree.rootNode as any).childCount = tree.rootNode.children.length;
    (tree.rootNode as any).child = (i: number) => tree.rootNode.children[i] ?? null;
    (tree.rootNode as any).endPosition = { row: 31, column: 0 };

    const results = computeMetrics(tree as any, LANG, [sym(1, 1, 21), sym(2, 26, 31)]);
    expect(results).toHaveLength(2);
    expect(results[0].cyclomatic).toBe(2); // fn1 has if
    expect(results[1].cyclomatic).toBe(1); // fn2 has nothing
  });

  it('else_clause counts as decision point → CC=3 for if+else', () => {
    const elseNode = node('else_clause', { start: 4, end: 5 });
    const ifNode = node('if_statement', { start: 2, end: 5, children: [elseNode] });
    const tree = mockTree('myFn', [ifNode], { start: 0, end: 20 });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.cyclomatic).toBe(3); // 1 base + if + else
  });

  it('do_statement → CC=2, loopDepth=1', () => {
    const doNode = node('do_statement', { start: 2, end: 5 });
    const tree = mockTree('myFn', [doNode], { start: 0, end: 20 });
    const [m] = computeMetrics(tree as any, LANG, [sym(1, 1, 21)]);
    expect(m.cyclomatic).toBe(2);
    expect(m.maxLoopDepth).toBe(1);
  });
});
