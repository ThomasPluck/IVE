import * as vscode from 'vscode';
import * as path from 'path';
import Parser from 'web-tree-sitter';
import { getLanguageConfig } from './languages.js';

export class TreeSitterParser {
  private parser: Parser | undefined;
  private languages: Map<string, Parser.Language> = new Map();
  private initPromise: Promise<void> | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const wasmPath = path.join(this.extensionUri.fsPath, 'dist', 'grammars', 'tree-sitter.wasm');
    await Parser.init({
      locateFile: () => wasmPath,
    });
    this.parser = new Parser();
  }

  async loadLanguage(language: string): Promise<boolean> {
    if (this.languages.has(language)) return true;

    const config = getLanguageConfig(language);
    if (!config) return false;

    try {
      const wasmPath = path.join(
        this.extensionUri.fsPath, 'dist', 'grammars', config.wasmFile
      );
      const lang = await Parser.Language.load(wasmPath);
      this.languages.set(language, lang);
      return true;
    } catch (err) {
      console.error(`IVE: Failed to load grammar for ${language}:`, err);
      return false;
    }
  }

  parse(source: string, language: string): Parser.Tree | undefined {
    if (!this.parser) return undefined;

    const lang = this.languages.get(language);
    if (!lang) return undefined;

    this.parser.setLanguage(lang);
    return this.parser.parse(source);
  }
}
