import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const isWatch = process.argv.includes("--watch");

// Stage LICENSE and resources/ into extension/ so `vsce package` picks them
// up. The extension lives in its own subdirectory while LICENSE + assets
// live at the repo root — this is the cheapest way to keep a single source
// of truth without committing duplicates.
stageAssets();

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

function stageAssets() {
  const srcLicense = path.join(repoRoot, "LICENSE");
  const dstLicense = path.join(__dirname, "LICENSE");
  if (fs.existsSync(srcLicense) && !isSymlinkOrCopyUpToDate(srcLicense, dstLicense)) {
    fs.copyFileSync(srcLicense, dstLicense);
  }
  const srcResources = path.join(repoRoot, "resources");
  const dstResources = path.join(__dirname, "resources");
  if (fs.existsSync(srcResources)) {
    fs.mkdirSync(dstResources, { recursive: true });
    for (const name of fs.readdirSync(srcResources)) {
      const from = path.join(srcResources, name);
      const to = path.join(dstResources, name);
      if (!isSymlinkOrCopyUpToDate(from, to)) {
        fs.copyFileSync(from, to);
      }
    }
  }
}

function isSymlinkOrCopyUpToDate(src, dst) {
  if (!fs.existsSync(dst)) return false;
  try {
    const s = fs.statSync(src);
    const d = fs.statSync(dst);
    return d.size === s.size && d.mtimeMs >= s.mtimeMs;
  } catch {
    return false;
  }
}
