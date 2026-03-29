export interface LanguageConfig {
  treeSitterName: string;
  wasmFile: string;
  symbolNodeTypes: string[];
  containerNodeTypes: string[];
  callExpressionTypes: string[];
  decisionNodeTypes: string[];
  loopNodeTypes: string[];
  parameterListField: string; // field name for parameter list on function nodes
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

export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP);
}
