// Helper: query IVE MCP server from CLI
// Usage: node scripts/ive-query.mjs <tool> [json-args]
import { spawn } from 'child_process';
import * as path from 'path';

const tool = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const INIT = JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'cli',version:'1.0'}}});
const CALL = JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:tool,arguments:args}});

const proc = spawn('node', [path.resolve('dist/mcp-server.js'), '--workspace', '.'], {stdio:['pipe','pipe','pipe']});
let out = '';
proc.stdout.on('data', d => out += d.toString());
proc.on('close', () => {
  const lines = out.trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  const text = last.result?.content?.[0]?.text;
  if (text) {
    try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
    catch { console.log(text); }
  } else {
    console.log(JSON.stringify(last, null, 2));
  }
});
proc.stdin.write(INIT + '\n');
proc.stdin.write(CALL + '\n');
proc.stdin.end();
