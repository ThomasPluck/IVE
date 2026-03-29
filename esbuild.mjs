import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const extCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: !isWatch,
});

const mcpCtx = await esbuild.context({
  entryPoints: ['src/mcp/server.ts'],
  bundle: true,
  outfile: 'dist/mcp-server.js',
  external: [],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: !isWatch,
});

const cliCtx = await esbuild.context({
  entryPoints: ['src/mcp/index-cli.ts'],
  bundle: true,
  outfile: 'dist/ive-index.js',
  external: [],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
});

if (isWatch) {
  console.log('[esbuild] watching...');
  await Promise.all([extCtx.watch(), mcpCtx.watch(), cliCtx.watch()]);
} else {
  await Promise.all([extCtx.rebuild(), mcpCtx.rebuild(), cliCtx.rebuild()]);
  await Promise.all([extCtx.dispose(), mcpCtx.dispose(), cliCtx.dispose()]);
}
