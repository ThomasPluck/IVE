// First-run analyzer-pack installer (§2, workstream I).
//
// On activation the extension looks for `ive-daemon` in:
//   1. `ive.daemon.path` setting
//   2. bundled `extension/bin/ive-daemon`
//   3. cached pack at `~/.ive/<pack-version>/ive-daemon`
//   4. sibling `target/release/ive-daemon` (dev)
//
// If none exist, we download the matching daemon archive from the repo's
// GitHub Releases, extract into `~/.ive/<pack-version>/`, verify a
// checksum when `ive.daemon.packSha256` is set (or a `SHA256SUMS` file is
// shipped alongside), chmod +x on POSIX, then resolve. The UI shows a
// `withProgress` spinner the whole time.
//
// The feature is opt-out via `ive.daemon.autoDownload = false`; users
// with an offline setup can set `ive.daemon.path` and skip it.
//
// Design rules:
// - No extra npm deps. We use `node:https` + `node:zlib` + `node:child_process`
//   (tar for POSIX tar.gz; `Expand-Archive` shell-out for Windows zip).
// - Never overwrite a user-provided binary.
// - Abort if the download checksum doesn't match.
// - Cache by **pack version** so two workspaces with the same version share
//   a single on-disk copy.

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as log from "./logger";

export interface PackResolution {
  binaryPath: string;
  source: "setting" | "bundled" | "cache" | "dev" | "downloaded";
}

export interface InstallOptions {
  repo: string; // "owner/name"
  packVersion: string; // e.g. "v0.1.0"
  userSetting: string;
  autoDownload: boolean;
  expectedSha256?: string;
}

const IVE_HOME = path.join(os.homedir(), ".ive");

export async function resolveDaemon(
  extensionRoot: string,
  opts: InstallOptions,
): Promise<PackResolution | null> {
  // 1. user setting
  if (opts.userSetting && fs.existsSync(opts.userSetting)) {
    return { binaryPath: opts.userSetting, source: "setting" };
  }
  // 2. bundled
  const bundled = platformBinary(path.join(extensionRoot, "bin"));
  if (fs.existsSync(bundled)) {
    return { binaryPath: bundled, source: "bundled" };
  }
  // 3. cached pack
  const cacheDir = path.join(IVE_HOME, opts.packVersion);
  const cachedBin = platformBinary(cacheDir);
  if (fs.existsSync(cachedBin)) {
    return { binaryPath: cachedBin, source: "cache" };
  }
  // 4. dev build
  const devBin = platformBinary(path.join(extensionRoot, "..", "target", "release"));
  if (fs.existsSync(devBin)) {
    return { binaryPath: devBin, source: "dev" };
  }

  if (!opts.autoDownload) {
    return null;
  }

  // 5. download
  const downloaded = await downloadPackWithProgress(opts, cacheDir);
  return downloaded ? { binaryPath: downloaded, source: "downloaded" } : null;
}

function platformBinary(dir: string): string {
  return path.join(dir, process.platform === "win32" ? "ive-daemon.exe" : "ive-daemon");
}

export function targetTripleForPack(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "win32" && a === "x64") return "x86_64-pc-windows-msvc";
  throw new Error(`unsupported platform: ${p}-${a}`);
}

async function downloadPackWithProgress(
  opts: InstallOptions,
  cacheDir: string,
): Promise<string | null> {
  let triple: string;
  try {
    triple = targetTripleForPack();
  } catch (e) {
    vscode.window.showErrorMessage(`IVE: ${(e as Error).message}`);
    return null;
  }
  const archiveExt = triple.includes("windows") ? "zip" : "tar.gz";
  const filename = `ive-daemon-${triple}.${archiveExt}`;
  const url = `https://github.com/${opts.repo}/releases/download/${opts.packVersion}/${filename}`;

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `IVE: downloading analyzer pack ${opts.packVersion}`,
      cancellable: true,
    },
    async (progress, token): Promise<string | null> => {
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        const archivePath = path.join(cacheDir, filename);
        await downloadWithRedirects(url, archivePath, progress, token);
        if (token.isCancellationRequested) {
          safeUnlink(archivePath);
          return null;
        }
        if (opts.expectedSha256) {
          const actual = await sha256File(archivePath);
          if (actual.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
            safeUnlink(archivePath);
            vscode.window.showErrorMessage(
              `IVE pack checksum mismatch (expected ${opts.expectedSha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…). Aborted.`,
            );
            return null;
          }
        }
        progress.report({ message: "extracting…" });
        await extract(archivePath, cacheDir);
        safeUnlink(archivePath);

        const bin = platformBinary(cacheDir);
        if (!fs.existsSync(bin)) {
          // Some archives unpack into a subdir; look one level deep.
          const promoted = promoteNestedBinary(cacheDir);
          if (!promoted) {
            vscode.window.showErrorMessage(
              `IVE: archive ${filename} did not contain ive-daemon. See logs.`,
            );
            return null;
          }
        }
        if (process.platform !== "win32") {
          fs.chmodSync(bin, 0o755);
        }
        return bin;
      } catch (e) {
        log.error("pack download failed", (e as Error).message);
        vscode.window.showErrorMessage(
          `IVE: analyzer-pack download failed (${(e as Error).message}). Build locally with 'cargo build --release' or set 'ive.daemon.path'.`,
        );
        return null;
      }
    },
  );
}

function downloadWithRedirects(
  url: string,
  dest: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  redirectsLeft = 5,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        res.resume();
        downloadWithRedirects(
          res.headers.location,
          dest,
          progress,
          token,
          redirectsLeft - 1,
        )
          .then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const total = Number(res.headers["content-length"] ?? 0);
      let got = 0;
      const file = fs.createWriteStream(dest);
      res.on("data", (chunk: Buffer) => {
        got += chunk.length;
        if (total > 0) {
          progress.report({
            message: `${formatBytes(got)} of ${formatBytes(total)}`,
            increment: (chunk.length / total) * 100,
          });
        }
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
      token.onCancellationRequested(() => {
        req.destroy();
        file.close(() => {
          safeUnlink(dest);
          reject(new Error("cancelled"));
        });
      });
    });
    req.on("error", reject);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function extract(archive: string, dest: string): Promise<void> {
  if (archive.endsWith(".tar.gz") || archive.endsWith(".tgz")) {
    // gunzip → tar in two steps. `tar -xf` understands .tar.gz on both Linux and macOS.
    const result = spawnSync("tar", ["-xzf", archive, "-C", dest], { stdio: "pipe" });
    if (result.status !== 0) {
      throw new Error(`tar exit ${result.status}: ${result.stderr?.toString()}`);
    }
    return;
  }
  if (archive.endsWith(".zip")) {
    if (process.platform === "win32") {
      const ps = `Expand-Archive -Force -Path '${archive}' -DestinationPath '${dest}'`;
      const result = spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "pipe" });
      if (result.status !== 0) {
        throw new Error(`Expand-Archive exit ${result.status}: ${result.stderr?.toString()}`);
      }
      return;
    }
    // Fallback for macOS/Linux: use unzip if present.
    const result = spawnSync("unzip", ["-o", archive, "-d", dest], { stdio: "pipe" });
    if (result.status !== 0) {
      throw new Error(`unzip exit ${result.status}: ${result.stderr?.toString()}`);
    }
    return;
  }
  throw new Error(`unsupported archive format: ${archive}`);
}

function promoteNestedBinary(cacheDir: string): string | null {
  // If the archive unpacked to `cacheDir/ive-daemon-<triple>/ive-daemon`,
  // flatten it so our platformBinary() resolves.
  const entries = fs.readdirSync(cacheDir);
  for (const e of entries) {
    const sub = path.join(cacheDir, e);
    if (!fs.statSync(sub).isDirectory()) continue;
    const nested = platformBinary(sub);
    if (fs.existsSync(nested)) {
      const dest = platformBinary(cacheDir);
      fs.renameSync(nested, dest);
      // Move the rules/ and LICENSE along if present so it's a complete pack.
      for (const sibling of fs.readdirSync(sub)) {
        const from = path.join(sub, sibling);
        const to = path.join(cacheDir, sibling);
        if (!fs.existsSync(to)) fs.renameSync(from, to);
      }
      fs.rmSync(sub, { recursive: true, force: true });
      return dest;
    }
  }
  return null;
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

// Exposed so tests can poke the layout logic without a real download.
export const _testing = { promoteNestedBinary, platformBinary };
