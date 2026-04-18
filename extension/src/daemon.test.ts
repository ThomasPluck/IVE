import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon, findDaemonBinary } from "./daemon";

const DAEMON_BIN = findDaemonBinary(
  path.resolve(__dirname, ".."),
  process.env.IVE_DAEMON_PATH,
);

const maybe = DAEMON_BIN && fs.existsSync(DAEMON_BIN) ? describe : describe.skip;

maybe("Daemon (subprocess)", () => {
  let tmp: string;
  let daemon: Daemon;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ive-extension-test-"));
    fs.writeFileSync(path.join(tmp, "requirements.txt"), "requests==2.31.0\n");
    fs.writeFileSync(
      path.join(tmp, "app.py"),
      [
        "import os",
        "import requests",
        "import huggingface_utils  # hallucinated",
        "",
        "def fetch(url):",
        "    if not url:",
        "        return None",
        "    return requests.get(url).text",
        "",
      ].join("\n"),
    );
    daemon = new Daemon({
      binaryPath: DAEMON_BIN!,
      workspace: tmp,
      logLevel: "warn",
    });
    daemon.start();
  });

  afterAll(async () => {
    await daemon.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("ping returns pong", async () => {
    const result = await daemon.call("ping");
    expect(result).toBe("pong");
  });

  it("workspace.scan surfaces hallucinated import via file.diagnostics", async () => {
    await daemon.call("workspace.scan");
    const list = await daemon.call("file.list");
    expect(list.map((f) => f.file)).toContain("app.py");
    const diags = await daemon.call("file.diagnostics", { file: "app.py" });
    const hall = diags.find((d) => d.code === "ive-hallucination/unknown-import");
    expect(hall, "one hallucinated import").toBeDefined();
    expect(hall!.severity).toBe("critical");
    expect(hall!.message).toContain("huggingface_utils");
  });

  it("slice.compute reports cpg capability degraded", async () => {
    await expect(
      daemon.call("slice.compute", {
        origin: {
          file: "app.py",
          range: { start: [4, 0], end: [4, 0] },
        },
        direction: "backward",
        kind: "thin",
        crossFile: true,
      }),
    ).rejects.toMatchObject({ code: -32000 });
  });

  it("workspace.healthSummary returns at least one file score", async () => {
    const scores = await daemon.call("workspace.healthSummary");
    expect(scores.length).toBeGreaterThan(0);
    const app = scores.find((s) => typeof s.target === "object" && (s.target as { file: string }).file === "app.py");
    expect(app).toBeDefined();
    expect(["yellow", "red"]).toContain(app!.bucket);
  });
});
