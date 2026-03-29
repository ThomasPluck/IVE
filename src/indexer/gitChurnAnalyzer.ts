import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface ChurnData {
  commitCount: number;
  recentCommitCount: number; // last 30 days
  lastAuthor: string | null;
  lastCommitDate: number | null; // unix timestamp
}

const EMPTY: ChurnData = {
  commitCount: 0,
  recentCommitCount: 0,
  lastAuthor: null,
  lastCommitDate: null,
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function isGitRepo(workspacePath: string): boolean {
  return fs.existsSync(path.join(workspacePath, '.git'));
}

export function getChurnForFile(workspacePath: string, filePath: string): ChurnData {
  try {
    const relPath = path.relative(workspacePath, filePath).replace(/\\/g, '/');
    // Each line: "<author_email> <unix_timestamp>"
    const output = execSync(
      `git log --follow --format="%ae %at" -- "${relPath}"`,
      { cwd: workspacePath, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!output) return EMPTY;

    const lines = output.split('\n').filter(Boolean);
    const now = Date.now();
    const cutoff = (now - THIRTY_DAYS_MS) / 1000; // unix seconds

    let recentCount = 0;
    let lastAuthor: string | null = null;
    let lastDate: number | null = null;

    for (const line of lines) {
      const spaceIdx = line.lastIndexOf(' ');
      if (spaceIdx === -1) continue;
      const author = line.slice(0, spaceIdx).trim();
      const ts = parseInt(line.slice(spaceIdx + 1).trim(), 10);

      if (lastAuthor === null) {
        lastAuthor = author;
        lastDate = isNaN(ts) ? null : ts;
      }
      if (!isNaN(ts) && ts >= cutoff) recentCount++;
    }

    return {
      commitCount: lines.length,
      recentCommitCount: recentCount,
      lastAuthor,
      lastCommitDate: lastDate,
    };
  } catch {
    // Not a git repo, file not tracked, git not installed — all safe to ignore
    return EMPTY;
  }
}
