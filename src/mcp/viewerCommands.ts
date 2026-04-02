import * as fs from 'fs';
import * as path from 'path';

export interface ViewerCommand {
  action: 'highlight';
  payload: { nodeIds: number[] };
  timestamp: number;
}

/**
 * Atomically write a viewer command to .ive/viewer-cmd.json.
 * The VSCode extension watches this file and dispatches to the webview.
 */
export function writeViewerCommand(workspacePath: string, command: ViewerCommand): void {
  const ivePath = path.join(workspacePath, '.ive');
  const cmdPath = path.join(ivePath, 'viewer-cmd.json');
  const tmpPath = cmdPath + '.tmp';

  if (!fs.existsSync(ivePath)) {
    fs.mkdirSync(ivePath, { recursive: true });
  }

  fs.writeFileSync(tmpPath, JSON.stringify(command), 'utf-8');
  fs.renameSync(tmpPath, cmdPath);
}
