export interface LanguageConfig {
  treeSitterName: string;
  wasmFile: string;
  symbolNodeTypes: string[];
  containerNodeTypes: string[];
  callExpressionTypes: string[];
  decisionNodeTypes: string[];
  loopNodeTypes: string[];
  parameterListField: string;
  builtinMemberNames: string[];
}

const TS_COMMON: Omit<LanguageConfig, 'treeSitterName' | 'wasmFile'> = {
  symbolNodeTypes: [
    'function_declaration',
    'class_declaration',
    'method_definition',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'arrow_function',
  ],
  containerNodeTypes: ['class_declaration', 'class_body', 'interface_declaration', 'enum_declaration'],
  callExpressionTypes: ['call_expression', 'new_expression'],
  decisionNodeTypes: [
    'if_statement', 'else_clause', 'for_statement', 'for_in_statement',
    'while_statement', 'do_statement', 'switch_case', 'catch_clause',
    'conditional_expression', 'ternary_expression',
  ],
  loopNodeTypes: ['for_statement', 'for_in_statement', 'for_of_statement', 'while_statement', 'do_statement'],
  parameterListField: 'parameters',
  builtinMemberNames: [
    'get', 'set', 'has', 'delete', 'clear', 'add', 'push', 'pop', 'shift', 'unshift',
    'map', 'filter', 'find', 'some', 'every', 'reduce', 'forEach', 'includes',
    'slice', 'splice', 'concat', 'join', 'sort', 'reverse', 'fill',
    'keys', 'values', 'entries', 'toString', 'valueOf',
    'then', 'catch', 'finally', 'resolve', 'reject',
    'exec', 'test', 'match', 'replace', 'split', 'trim',
    'log', 'warn', 'error', 'info', 'debug',
    'on', 'off', 'emit', 'once', 'removeListener',
    'read', 'write', 'close', 'open', 'end',
    'start', 'stop', 'run', 'init',
    'parse', 'stringify',
    'findFiles', 'showTextDocument', 'showInformationMessage', 'showErrorMessage',
    'registerCommand', 'registerWebviewViewProvider',
    'dispose', 'require',
  ],
};

const LANGUAGES: Record<string, LanguageConfig> = {
  typescript: { ...TS_COMMON, treeSitterName: 'typescript', wasmFile: 'tree-sitter-typescript.wasm' },
  tsx: { ...TS_COMMON, treeSitterName: 'tsx', wasmFile: 'tree-sitter-tsx.wasm' },
  javascript: {
    ...TS_COMMON,
    treeSitterName: 'javascript',
    wasmFile: 'tree-sitter-javascript.wasm',
    symbolNodeTypes: ['function_declaration', 'class_declaration', 'method_definition', 'arrow_function'],
    containerNodeTypes: ['class_declaration', 'class_body'],
  },
  python: {
    treeSitterName: 'python',
    wasmFile: 'tree-sitter-python.wasm',
    symbolNodeTypes: [
      'function_definition',
      'class_definition',
    ],
    containerNodeTypes: ['class_definition'],
    callExpressionTypes: ['call'],
    decisionNodeTypes: [
      'if_statement', 'elif_clause', 'else_clause', 'for_statement',
      'while_statement', 'except_clause', 'conditional_expression',
    ],
    loopNodeTypes: ['for_statement', 'while_statement'],
    parameterListField: 'parameters',
    builtinMemberNames: [
      'get', 'set', 'has', 'keys', 'values', 'items', 'pop', 'append', 'extend',
      'update', 'remove', 'clear', 'copy', 'sort', 'reverse',
      'join', 'split', 'strip', 'replace', 'find', 'format',
      'read', 'write', 'close', 'open', 'flush', 'seek',
      'encode', 'decode', 'lower', 'upper', 'startswith', 'endswith',
    ],
  },
  rust: {
    treeSitterName: 'rust',
    wasmFile: 'tree-sitter-rust.wasm',
    symbolNodeTypes: [
      'function_item',
      'impl_item',
      'struct_item',
      'enum_item',
      'trait_item',
    ],
    containerNodeTypes: ['impl_item', 'trait_item'],
    callExpressionTypes: ['call_expression', 'method_call_expression'],
    decisionNodeTypes: [
      'if_expression', 'match_expression', 'match_arm',
      'while_expression', 'for_expression', 'loop_expression',
      'if_let_expression', 'while_let_expression',
    ],
    loopNodeTypes: ['while_expression', 'for_expression', 'loop_expression'],
    parameterListField: 'parameters',
    builtinMemberNames: [
      'get', 'set', 'insert', 'remove', 'contains', 'push', 'pop', 'len',
      'iter', 'map', 'filter', 'collect', 'unwrap', 'expect', 'clone',
      'to_string', 'as_ref', 'into', 'from', 'new',
      'read', 'write', 'flush', 'close', 'lock',
    ],
  },
  go: {
    treeSitterName: 'go',
    wasmFile: 'tree-sitter-go.wasm',
    symbolNodeTypes: [
      'function_declaration',
      'method_declaration',
      'type_declaration',
    ],
    containerNodeTypes: ['type_declaration'],
    callExpressionTypes: ['call_expression'],
    decisionNodeTypes: [
      'if_statement', 'for_statement',
      'expression_switch_statement', 'type_switch_statement', 'select_statement',
    ],
    loopNodeTypes: ['for_statement'],
    parameterListField: 'parameters',
    builtinMemberNames: [
      'Get', 'Set', 'Delete', 'Len', 'Close', 'Read', 'Write',
      'Lock', 'Unlock', 'Add', 'Done', 'Wait',
      'Println', 'Printf', 'Sprintf', 'Errorf',
    ],
  },
};

const EXTENSION_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.rs': 'rust',
  '.go': 'go',
};

export function getLanguageForFile(filePath: string): string | undefined {
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  return EXTENSION_MAP[ext];
}

export function getLanguageConfig(language: string): LanguageConfig | undefined {
  return LANGUAGES[language];
}

/** Merged set of all builtin member names across all languages. */
export function getAllBuiltinMemberNames(): Set<string> {
  const all = new Set<string>();
  for (const config of Object.values(LANGUAGES)) {
    for (const name of config.builtinMemberNames) all.add(name);
  }
  return all;
}

export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP);
}
