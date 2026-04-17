import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/server.ts"],
  bundle: true,
  outfile: "dist/server.js",
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: !isWatch,
  banner: { js: "#!/usr/bin/env node" },
});

if (isWatch) {
  console.log("[esbuild] watching ive-mcp…");
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
