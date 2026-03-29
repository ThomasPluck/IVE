import { describe, it, expect } from 'vitest';
import { extractSymbols } from '../parser/symbolExtractor.js';
import { node, ident } from './helpers/mockNode.js';

/** Wrap children in a program root node */
function program(...children: ReturnType<typeof node>[]) {
  return { rootNode: node('program', { children, start: 0, end: 50 }) };
}

/** A function_declaration with an optional body */
function fnDecl(name: string, bodyChildren: ReturnType<typeof node>[] = []) {
  const bodyNode = node('statement_block', { children: bodyChildren, start: 1, end: 19 });
  const fn = node('function_declaration', {
    start: 0, end: 20,
    fields: { name: ident(name), body: bodyNode },
    children: [ident(name), bodyNode],
  });
  return fn;
}

/** A class_declaration with optional body children (methods) */
function classDecl(name: string, bodyChildren: ReturnType<typeof node>[] = []) {
  const bodyNode = node('class_body', { children: bodyChildren, start: 1, end: 19 });
  return node('class_declaration', {
    start: 0, end: 20,
    fields: { name: ident(name), body: bodyNode },
    children: [ident(name), bodyNode],
  });
}

/** A method_definition */
function methodDef(name: string) {
  return node('method_definition', {
    start: 2, end: 8,
    fields: { name: ident(name) },
    children: [ident(name)],
  });
}

describe('extractSymbols — TypeScript', () => {
  it('extracts a function_declaration', () => {
    const tree = program(fnDecl('myFn'));
    const syms = extractSymbols(tree as any, 'typescript');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('myFn');
    expect(syms[0].kind).toBe('function');
  });

  it('extracts a class_declaration', () => {
    const tree = program(classDecl('MyClass'));
    const syms = extractSymbols(tree as any, 'typescript');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('MyClass');
    expect(syms[0].kind).toBe('class');
  });

  it('extracts a method_definition', () => {
    // methods extracted from class body
    const method = methodDef('doWork');
    const cls = classDecl('MyClass', [method]);
    const tree = program(cls);
    const syms = extractSymbols(tree as any, 'typescript');
    expect(syms[0].children).toHaveLength(1);
    expect(syms[0].children[0].name).toBe('doWork');
    expect(syms[0].children[0].kind).toBe('method');
  });

  it('extracts arrow function from lexical_declaration', () => {
    const arrowFn = node('arrow_function', { start: 0, end: 5 });
    const varDeclarator = node('variable_declarator', {
      start: 0, end: 5,
      fields: { name: ident('myArrow'), value: arrowFn },
      children: [ident('myArrow'), arrowFn],
    });
    const lexDecl = node('lexical_declaration', {
      start: 0, end: 5,
      children: [varDeclarator],
    });
    const tree = program(lexDecl);
    const syms = extractSymbols(tree as any, 'typescript');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('myArrow');
    expect(syms[0].kind).toBe('function');
  });

  it('unknown node type is excluded from output', () => {
    const unknown = node('unknown_future_node', {
      start: 0, end: 5,
      fields: { name: ident('ghost') },
      children: [ident('ghost')],
    });
    const tree = program(unknown);
    const syms = extractSymbols(tree as any, 'typescript');
    // 'unknown_future_node' not in symbolNodeTypes → not extracted
    expect(syms).toHaveLength(0);
  });

  it('class with 2 method children populates children array', () => {
    const cls = classDecl('Widget', [methodDef('render'), methodDef('update')]);
    const tree = program(cls);
    const syms = extractSymbols(tree as any, 'typescript');
    expect(syms[0].children).toHaveLength(2);
  });

  it('empty root node returns empty array', () => {
    const tree = { rootNode: node('program', { children: [], start: 0, end: 0 }) };
    expect(extractSymbols(tree as any, 'typescript')).toHaveLength(0);
  });

  it('unsupported language returns empty array', () => {
    const tree = program(fnDecl('main'));
    expect(extractSymbols(tree as any, 'cobol')).toHaveLength(0);
  });

  it('export_statement wrapping function_declaration → extracted', () => {
    const fn = fnDecl('exportedFn');
    const exportStmt = node('export_statement', {
      start: 0, end: 20,
      children: [fn],
    });
    const tree = program(exportStmt);
    const syms = extractSymbols(tree as any, 'typescript');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('exportedFn');
    expect(syms[0].kind).toBe('function');
  });

  it('variable_declarator with non-arrow value → excluded', () => {
    const numLiteral = node('number', { text: '42', start: 0, end: 0 });
    const varDecl = node('variable_declarator', {
      start: 0, end: 0,
      fields: { name: ident('myVar'), value: numLiteral },
      children: [ident('myVar'), numLiteral],
    });
    const lexDecl = node('lexical_declaration', {
      start: 0, end: 0,
      children: [varDecl],
    });
    const tree = program(lexDecl);
    const syms = extractSymbols(tree as any, 'typescript');
    expect(syms).toHaveLength(0);
  });
});

describe('extractSymbols — Rust', () => {
  it('extracts function_item', () => {
    const fn = node('function_item', {
      start: 0, end: 10,
      fields: { name: ident('my_fn') },
      children: [ident('my_fn')],
    });
    const tree = program(fn);
    const syms = extractSymbols(tree as any, 'rust');
    expect(syms).toHaveLength(1);
    expect(syms[0].kind).toBe('function');
    expect(syms[0].name).toBe('my_fn');
  });

  it('extracts impl_item as class', () => {
    const impl = node('impl_item', {
      start: 0, end: 20,
      fields: { name: ident('MyStruct') },
      children: [ident('MyStruct')],
    });
    const tree = program(impl);
    const syms = extractSymbols(tree as any, 'rust');
    expect(syms).toHaveLength(1);
    expect(syms[0].kind).toBe('class');
  });
});

describe('extractSymbols — Python', () => {
  it('extracts function_definition', () => {
    const fn = node('function_definition', {
      start: 0, end: 10,
      fields: { name: ident('my_func') },
      children: [ident('my_func')],
    });
    const tree = program(fn);
    const syms = extractSymbols(tree as any, 'python');
    expect(syms).toHaveLength(1);
    expect(syms[0].kind).toBe('function');
    expect(syms[0].name).toBe('my_func');
  });
});

describe('extractSymbols — Go', () => {
  it('extracts method_declaration as method', () => {
    const method = node('method_declaration', {
      start: 0, end: 10,
      fields: { name: ident('DoWork') },
      children: [ident('DoWork')],
    });
    const tree = program(method);
    const syms = extractSymbols(tree as any, 'go');
    expect(syms).toHaveLength(1);
    expect(syms[0].kind).toBe('method');
  });
});
