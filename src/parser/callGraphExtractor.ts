import type Parser from 'web-tree-sitter';
import { getLanguageConfig } from './languages.js';
import { findNodeAtRange } from './astUtils.js';
import type { IVEDatabase, SymbolRow } from '../indexer/database.js';
import type { ImportBinding } from './symbolExtractor.js';

export interface RawEdge {
  sourceSymbolId: number;
  calleeName: string;
  sourceFileId: number;
  callLine: number;
  callText: string;
  isMemberCall: boolean;
}

export interface ResolvedEdge {
  sourceId: number;
  targetId: number;
  kind: 'call';
  callLine: number;
  callText: string;
}

export function extractRawCallEdges(
  tree: Parser.Tree,
  language: string,
  symbols: SymbolRow[]
): RawEdge[] {
  const config = getLanguageConfig(language);
  if (!config || config.callExpressionTypes.length === 0) return [];

  const callableSymbols = symbols.filter(s =>
    s.kind === 'function' || s.kind === 'method' || s.kind === 'test'
  );

  const callExprSet = new Set(config.callExpressionTypes);
  const edges: RawEdge[] = [];

  for (const sym of callableSymbols) {
    const symNode = findNodeAtRange(tree.rootNode, sym.startLine - 1, sym.endLine - 1);
    if (!symNode) continue;

    const callSites = collectCallSites(symNode, callExprSet);
    for (const site of callSites) {
      if (site.name && site.name !== sym.name) {
        edges.push({
          sourceSymbolId: sym.id,
          calleeName: site.name,
          sourceFileId: sym.fileId,
          callLine: site.line,
          callText: site.text,
          isMemberCall: site.isMemberCall,
        });
      }
    }
  }

  return edges;
}

export function resolveEdges(
  rawEdges: RawEdge[],
  db: IVEDatabase,
  builtinNames?: Set<string>,
  importsByFile?: Map<number, ImportBinding[]>
): ResolvedEdge[] {
  const resolved: ResolvedEdge[] = [];
  const seen = new Set<string>();

  for (const raw of rawEdges) {
    if (raw.isMemberCall && builtinNames?.has(raw.calleeName)) continue;

    let candidates = db.lookupSymbolsByName(raw.calleeName);

    // Fallback: if name not found, check import aliases for the original exported name
    if (candidates.length === 0 && importsByFile) {
      const imports = importsByFile.get(raw.sourceFileId);
      if (imports) {
        const binding = imports.find(b => b.localName === raw.calleeName);
        if (binding && binding.importedName !== binding.localName) {
          candidates = db.lookupSymbolsByName(binding.importedName);
        }
      }
    }

    if (candidates.length === 0) continue;

    // Member calls (obj.method()) prefer methods over standalone functions
    if (raw.isMemberCall) {
      const methods = candidates.filter(c => c.kind === 'method');
      if (methods.length > 0) candidates = methods;
    }

    const sameFile = candidates.find(c => c.fileId === raw.sourceFileId);
    const target = sameFile ?? candidates[0];

    const key = `${raw.sourceSymbolId}:${target.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push({
        sourceId: raw.sourceSymbolId,
        targetId: target.id,
        kind: 'call',
        callLine: raw.callLine,
        callText: raw.callText,
      });
    }
  }

  return resolved;
}

interface CallSite {
  name: string;
  line: number;
  text: string;
  isMemberCall: boolean;
}

function collectCallSites(node: Parser.SyntaxNode, callExprTypes: Set<string>): CallSite[] {
  const sites: CallSite[] = [];
  visitNode(node, callExprTypes, sites);
  return sites;
}

function visitNode(node: Parser.SyntaxNode, callExprTypes: Set<string>, sites: CallSite[]): void {
  if (callExprTypes.has(node.type)) {
    const info = extractCalleeInfo(node);
    if (info) {
      const text = node.text.length > 60 ? node.text.slice(0, 57) + '...' : node.text;
      sites.push({ name: info.name, line: node.startPosition.row + 1, text, isMemberCall: info.isMemberCall });
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) visitNode(child, callExprTypes, sites);
  }
}

function extractCalleeInfo(callNode: Parser.SyntaxNode): { name: string; isMemberCall: boolean } | null {
  const funcChild = callNode.childForFieldName('function') ?? callNode.child(0);
  if (!funcChild) return null;

  if (funcChild.type === 'identifier') return { name: funcChild.text, isMemberCall: false };

  if (funcChild.type === 'member_expression') {
    const prop = funcChild.childForFieldName('property');
    return prop ? { name: prop.text, isMemberCall: true } : null;
  }

  if (funcChild.type === 'attribute') {
    const attr = funcChild.childForFieldName('attribute');
    return attr ? { name: attr.text, isMemberCall: true } : null;
  }

  return null;
}
