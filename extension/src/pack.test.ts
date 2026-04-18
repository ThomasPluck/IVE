import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _testing, targetTripleForPack } from "./pack";

const { platformBinary, promoteNestedBinary } = _testing;

describe("pack", () => {
  it("platformBinary appends .exe on Windows and not on POSIX", () => {
    const dir = "/tmp/ive-pack-test";
    const bin = platformBinary(dir);
    if (process.platform === "win32") {
      expect(bin.endsWith("ive-daemon.exe")).toBe(true);
    } else {
      expect(bin.endsWith("ive-daemon")).toBe(true);
      expect(bin.endsWith(".exe")).toBe(false);
    }
  });

  it("targetTripleForPack returns a known triple for the current host", () => {
    // On unsupported hosts it throws — we only assert the call shape.
    try {
      const triple = targetTripleForPack();
      expect(triple).toMatch(/linux|darwin|windows/);
    } catch (e) {
      expect((e as Error).message).toMatch(/unsupported platform/);
    }
  });

  it("promoteNestedBinary flattens an archive-style subdir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ive-pack-flatten-"));
    const inner = path.join(tmp, "ive-daemon-nested");
    fs.mkdirSync(inner, { recursive: true });
    const binName = process.platform === "win32" ? "ive-daemon.exe" : "ive-daemon";
    fs.writeFileSync(path.join(inner, binName), "#!/bin/sh\necho hi\n");
    fs.writeFileSync(path.join(inner, "LICENSE"), "MIT");
    fs.mkdirSync(path.join(inner, "rules"), { recursive: true });
    fs.writeFileSync(path.join(inner, "rules", "ive-ai-slop.yml"), "rules: []\n");

    const promoted = promoteNestedBinary(tmp);
    expect(promoted).not.toBeNull();
    expect(fs.existsSync(path.join(tmp, binName))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "LICENSE"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "rules", "ive-ai-slop.yml"))).toBe(true);
    // The nested directory was cleaned up.
    expect(fs.existsSync(inner)).toBe(false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("promoteNestedBinary returns null when no nested binary exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ive-pack-nothing-"));
    fs.writeFileSync(path.join(tmp, "README.md"), "nothing here");
    const promoted = promoteNestedBinary(tmp);
    expect(promoted).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
