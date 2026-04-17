// Playwright coverage for the Vibe panel (Claude ↔ user note feed,
// spec §0 bond-by-legibility). Drives the built webview in real
// Chromium, dispatches `notesUpdated` events like the extension host
// would after a `notes.post` RPC, and asserts every interactive
// surface lights up.
//
// Also captures a screenshot to e2e/screenshots/vibe.png so visual
// regressions are easy to spot. The screenshot is gitignored because
// .png blobs belong in object storage, not git.

import { test, expect } from "./fixtures";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOTS_DIR = path.resolve(__dirname, "screenshots");

function seedNotes() {
  return [
    {
      id: "n-1",
      kind: "concern",
      title: "fetch() composite 0.82 — unknown import + cc=7",
      body: "Worth a refactor before this grows further.",
      location: {
        file: "services/slop.py",
        range: { start: [4, 0], end: [4, 0] },
      },
      severity: "warning",
      author: "claude",
      createdAt: "2026-04-17T21:59:00Z",
    },
    {
      id: "n-2",
      kind: "intent",
      title: "Replacing `huggingface_utils` with sentence-transformers",
      body: "Will update requirements.txt and swap the two call sites.",
      location: {
        file: "services/slop.py",
        range: { start: [2, 0], end: [2, 0] },
      },
      author: "claude",
      createdAt: "2026-04-17T22:00:00Z",
    },
    {
      id: "n-3",
      kind: "question",
      title: "Keep the retry loop inside fetch(), or hoist it?",
      body: "The retry semantics look hand-rolled; could use tenacity instead.",
      author: "claude",
      createdAt: "2026-04-17T22:00:30Z",
    },
  ];
}

test.describe("IVE Vibe panel", () => {
  test("empty state explains the MCP surface", async ({ page, view }) => {
    void view;
    const vibe = page.locator(".panel-vibe");
    await expect(vibe).toBeVisible();
    await expect(vibe.getByText(/No notes yet/)).toBeVisible();
    await expect(vibe.getByText(/ive_post_note/)).toBeVisible();
  });

  test("renders every note kind with its glyph and title", async ({
    page,
    view,
  }) => {
    await view.dispatch({ type: "event", payload: { type: "notesUpdated", notes: seedNotes() } });

    const rows = page.locator(".vibe-row");
    await expect(rows).toHaveCount(3);

    // Each kind class lands correctly.
    await expect(page.locator(".vibe-row.note-concern")).toHaveCount(1);
    await expect(page.locator(".vibe-row.note-intent")).toHaveCount(1);
    await expect(page.locator(".vibe-row.note-question")).toHaveCount(1);

    // Titles render.
    await expect(page.getByText(/fetch\(\) composite 0\.82/)).toBeVisible();
    await expect(page.getByText(/Replacing `huggingface_utils`/)).toBeVisible();
    await expect(page.getByText(/Keep the retry loop/)).toBeVisible();

    // The panel header shows the count.
    await expect(page.locator(".panel-vibe > header")).toContainText("[3]");
  });

  test("clicking a located note posts openFile with its range", async ({
    page,
    view,
  }) => {
    await view.dispatch({ type: "event", payload: { type: "notesUpdated", notes: seedNotes() } });
    await view.clearOutgoing();

    await page.locator(".vibe-row.note-concern").click();
    const outgoing = (await view.outgoing()) as {
      type: string;
      location?: { file: string; range: { start: [number, number] } };
    }[];
    const openFile = outgoing.find((m) => m.type === "openFile");
    expect(openFile).toBeDefined();
    expect(openFile!.location!.file).toBe("services/slop.py");
    expect(openFile!.location!.range.start[0]).toBe(4);
  });

  test("resolve button posts resolveNote with the note id", async ({
    page,
    view,
  }) => {
    await view.dispatch({ type: "event", payload: { type: "notesUpdated", notes: seedNotes() } });
    await view.clearOutgoing();

    await page
      .locator(".vibe-row.note-intent .vibe-resolve")
      .click();
    const outgoing = (await view.outgoing()) as {
      type: string;
      id?: string;
    }[];
    const resolve = outgoing.find((m) => m.type === "resolveNote");
    expect(resolve).toBeDefined();
    expect(resolve!.id).toBe("n-2");
  });

  test("captures a screenshot of the full sidebar for visual review", async ({
    page,
    view,
  }) => {
    // Give the Vibe panel enough height that every note is visible in
    // the screenshot — the production VSCode sidebar is much taller
    // than Playwright's default 720px.
    await page.setViewportSize({ width: 1280, height: 1600 });
    await view.dispatch({ type: "event", payload: { type: "notesUpdated", notes: seedNotes() } });
    // Give CSS transitions a tick to settle.
    await page.waitForTimeout(150);
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SHOTS_DIR, "sidebar.png"),
      fullPage: true,
    });
    expect(fs.existsSync(path.join(SHOTS_DIR, "sidebar.png"))).toBe(true);
  });

  test("captures a zoomed-in Vibe screenshot", async ({ page, view }) => {
    await page.setViewportSize({ width: 1280, height: 1600 });
    await view.dispatch({ type: "event", payload: { type: "notesUpdated", notes: seedNotes() } });
    await page.waitForTimeout(150);
    // Scroll the vibe panel into view and screenshot it — forces the
    // list to render its full content height even when the flex layout
    // would normally clip it.
    await page.locator(".panel-vibe").evaluate((el) => el.scrollIntoView());
    const vibe = page.locator(".panel-vibe");
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await vibe.screenshot({ path: path.join(SHOTS_DIR, "vibe.png") });
    expect(fs.existsSync(path.join(SHOTS_DIR, "vibe.png"))).toBe(true);
  });
});
