import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import { getDiffSummary } from '../indexer/diffAnalyzer.js';

const WS = '/workspace';
const mockExec = execSync as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getDiffSummary', () => {
  it('returns empty result when execSync throws', () => {
    mockExec.mockImplementation(() => { throw new Error('not a git repo'); });
    const result = getDiffSummary(WS);
    expect(result.modifiedFiles).toEqual([]);
    expect(result.addedLines.size).toBe(0);
    expect(result.deletedLines.size).toBe(0);
  });

  it('returns empty when diff output is empty', () => {
    mockExec.mockReturnValueOnce('');
    const result = getDiffSummary(WS);
    expect(result.modifiedFiles).toEqual([]);
  });

  it('parses a simple hunk correctly', () => {
    const filePath = 'src/foo.ts';
    mockExec.mockReturnValueOnce(
      `diff --git a/${filePath} b/${filePath}\n` +
      `+++ b/${filePath}\n` +
      `@@ -3,2 +3,4 @@\n`
    );

    const result = getDiffSummary(WS);
    const absPath = path.join(WS, filePath);

    expect(result.modifiedFiles).toContain(absPath);
    expect(result.addedLines.get(absPath)).toEqual([3, 4, 5, 6]);
    expect(result.deletedLines.get(absPath)).toEqual([3, 4]);
  });

  it('defaults count to 1 when omitted from hunk header', () => {
    const filePath = 'src/bar.ts';
    mockExec.mockReturnValueOnce(
      `+++ b/${filePath}\n` +
      `@@ -5 +5 @@\n`
    );

    const result = getDiffSummary(WS);
    const absPath = path.join(WS, filePath);
    expect(result.addedLines.get(absPath)).toEqual([5]);
    expect(result.deletedLines.get(absPath)).toEqual([5]);
  });

  it('does not add entries when addCount is 0', () => {
    const filePath = 'src/baz.ts';
    mockExec.mockReturnValueOnce(
      `+++ b/${filePath}\n` +
      `@@ -2,3 +2,0 @@\n`
    );

    const result = getDiffSummary(WS);
    const absPath = path.join(WS, filePath);
    expect(result.addedLines.get(absPath)).toBeUndefined();
    expect(result.deletedLines.get(absPath)).toEqual([2, 3, 4]);
  });

  it('accumulates lines from multiple hunks in the same file', () => {
    const filePath = 'src/multi.ts';
    mockExec.mockReturnValueOnce(
      `+++ b/${filePath}\n` +
      `@@ -1,1 +1,2 @@\n` +
      `@@ -10,1 +11,3 @@\n`
    );

    const result = getDiffSummary(WS);
    const absPath = path.join(WS, filePath);
    const added = result.addedLines.get(absPath) ?? [];
    expect(added).toContain(1);
    expect(added).toContain(2);
    expect(added).toContain(11);
    expect(added).toContain(12);
    expect(added).toContain(13);
  });

  it('assigns lines to the correct file for multiple files', () => {
    const file1 = 'src/a.ts';
    const file2 = 'src/b.ts';
    mockExec.mockReturnValueOnce(
      `+++ b/${file1}\n` +
      `@@ -1,1 +1,1 @@\n` +
      `+++ b/${file2}\n` +
      `@@ -5,1 +5,2 @@\n`
    );

    const result = getDiffSummary(WS);
    const abs1 = path.join(WS, file1);
    const abs2 = path.join(WS, file2);

    expect(result.addedLines.get(abs1)).toEqual([1]);
    expect(result.addedLines.get(abs2)).toEqual([5, 6]);
  });

  it('joins relative paths with workspacePath', () => {
    const file = 'deep/nested/file.ts';
    mockExec.mockReturnValueOnce(`+++ b/${file}\n@@ -1 +1 @@\n`);

    const result = getDiffSummary(WS);
    const expected = path.join(WS, file);
    expect(result.modifiedFiles).toContain(expected);
  });
});
