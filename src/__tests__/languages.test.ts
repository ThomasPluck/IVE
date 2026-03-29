import { describe, it, expect } from 'vitest';
import { getLanguageForFile, getLanguageConfig, getSupportedExtensions } from '../parser/languages.js';

describe('getLanguageForFile', () => {
  it('.ts → typescript', () => expect(getLanguageForFile('foo.ts')).toBe('typescript'));
  it('.tsx → tsx',       () => expect(getLanguageForFile('foo.tsx')).toBe('tsx'));
  it('.js → javascript', () => expect(getLanguageForFile('foo.js')).toBe('javascript'));
  it('.py → python',     () => expect(getLanguageForFile('foo.py')).toBe('python'));
  it('.rs → rust',       () => expect(getLanguageForFile('foo.rs')).toBe('rust'));
  it('.go → go',         () => expect(getLanguageForFile('foo.go')).toBe('go'));

  it('unknown extension → undefined', () => expect(getLanguageForFile('foo.xyz')).toBeUndefined());
  it('no extension → undefined',      () => expect(getLanguageForFile('Makefile')).toBeUndefined());
  it('multiple dots uses last extension', () => {
    // file.tar.gz → .gz which is not supported
    expect(getLanguageForFile('archive.tar.gz')).toBeUndefined();
    // But file.test.ts → .ts → typescript
    expect(getLanguageForFile('foo.test.ts')).toBe('typescript');
  });
});

describe('getLanguageConfig', () => {
  it('returns config for typescript', () => {
    const cfg = getLanguageConfig('typescript');
    expect(cfg).toBeDefined();
  });

  it('returns undefined for unknown language', () => {
    expect(getLanguageConfig('cobol')).toBeUndefined();
  });

  it('all 6 language configs have required fields', () => {
    const required = [
      'symbolNodeTypes',
      'callExpressionTypes',
      'loopNodeTypes',
      'decisionNodeTypes',
      'parameterListField',
    ] as const;

    for (const lang of ['typescript', 'tsx', 'javascript', 'python', 'rust', 'go']) {
      const cfg = getLanguageConfig(lang);
      expect(cfg, `config for ${lang}`).toBeDefined();
      for (const field of required) {
        expect((cfg as Record<string, unknown>)[field], `${lang}.${field}`).toBeDefined();
      }
    }
  });
});

describe('getSupportedExtensions', () => {
  it('returns a non-empty array of strings starting with dot', () => {
    const exts = getSupportedExtensions();
    expect(exts.length).toBeGreaterThan(0);
    for (const e of exts) {
      expect(e.startsWith('.')).toBe(true);
    }
  });
});
