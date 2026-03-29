import { execSync } from 'child_process';
import * as path from 'path';

export interface DiffSummary {
  modifiedFiles: string[];
  addedLines: Map<string, number[]>;
  deletedLines: Map<string, number[]>;
}

export function getDiffSummary(workspacePath: string): DiffSummary {
  const result: DiffSummary = {
    modifiedFiles: [],
    addedLines: new Map(),
    deletedLines: new Map(),
  };

  try {
    const diffOutput = execSync('git diff HEAD --unified=0', {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 10000,
    });

    const modifiedFileSet = new Set<string>();
    let currentFile: string | null = null;
    for (const line of diffOutput.split('\n')) {
      if (line.startsWith('+++ b/')) {
        currentFile = path.join(workspacePath, line.slice(6));
        modifiedFileSet.add(currentFile);
      } else if (line.startsWith('@@ ') && currentFile) {
        const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (match) {
          const addStart = parseInt(match[3]);
          const addCount = match[4] !== undefined ? parseInt(match[4]) : 1;
          const delStart = parseInt(match[1]);
          const delCount = match[2] !== undefined ? parseInt(match[2]) : 1;

          if (addCount > 0) appendLineRange(result.addedLines, currentFile, addStart, addCount);
          if (delCount > 0) appendLineRange(result.deletedLines, currentFile, delStart, delCount);
        }
      }
    }
    result.modifiedFiles = [...modifiedFileSet];
  } catch {
    // Not a git repo or no staged/unstaged changes
  }

  return result;
}

function appendLineRange(map: Map<string, number[]>, file: string, start: number, count: number): void {
  const lines = map.get(file) ?? [];
  for (let i = start; i < start + count; i++) lines.push(i);
  map.set(file, lines);
}
