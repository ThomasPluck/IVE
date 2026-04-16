import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: !isWatch,
});

if (isWatch) {
  console.log("[esbuild] watching extension…");
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
