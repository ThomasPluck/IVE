// Visual coverage for the "attention" primitives — how Claude points at
// the UI without writing a line of text. Each test asserts a concrete
// DOM signal (class / attribute / element) AND captures a screenshot
// we visually review.

import { test, expect } from "./fixtures";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOTS_DIR = path.resolve(__dirname, "screenshots");

function concernNote(file = "services/slop.py") {
  return {
    id: "n-concern",
    kind: "concern",
    title: "fetch() composite 0.82 — urgent",
    body: "",
    location: { file, range: { start: [4, 0], end: [4, 0] } },
    severity: "warning",
    author: "claude",
    createdAt: new Date().toISOString(),
  };
}

function intentNote(file = "services/clean.py") {
  return {
    id: "n-intent",
    kind: "intent",
    title: "Adding type hints across `clean.py`",
    body: "",
    location: { file, range: { start: [0, 0], end: [0, 0] } },
    author: "claude",
    createdAt: new Date().toISOString(),
  };
}

test.describe("attention primitives", () => {
  test("spotlight rings render on every tile an active note anchors", async ({
    page,
    view,
  }) => {
    await view.dispatch({
      type: "event",
      payload: { type: "notesUpdated", notes: [concernNote(), intentNote()] },
    });
    const rings = page.locator(".spotlight-ring");
    // Two notes, each anchored to a distinct file → two rings.
    await expect(rings).toHaveCount(2);
    // Concern (warning severity) → yellow stroke.
    const concernStroke = await rings.nth(0).getAttribute("stroke");
    const intentStroke = await rings.nth(1).getAttribute("stroke");
    expect([concernStroke, intentStroke]).toContain("var(--ive-yellow)");
    expect([concernStroke, intentStroke]).toContain("var(--ive-magenta)");
  });

  test("clicking a Vibe note focuses the treemap on that file", async ({
    page,
    view,
  }) => {
    await view.dispatch({
      type: "event",
      payload: { type: "notesUpdated", notes: [concernNote(), intentNote()] },
    });
    // Before focus: no dim / no focused tile.
    await expect(page.locator(".tile-dimmed")).toHaveCount(0);
    await expect(page.locator(".tile-focused")).toHaveCount(0);

    await page.locator(".vibe-row.note-concern").click();
    // After focus: exactly one focused tile, every other tile dimmed.
    await expect(page.locator(".tile-focused")).toHaveCount(1);
    const totalTiles = await page.locator(".treemap svg g").count();
    await expect(page.locator(".tile-dimmed")).toHaveCount(totalTiles - 1);

    // The focus-reset escape hatch appears.
    const reset = page.locator(".focus-reset");
    await expect(reset).toBeVisible();
    await reset.click();
    // Cleared.
    await expect(page.locator(".tile-focused")).toHaveCount(0);
    await expect(page.locator(".tile-dimmed")).toHaveCount(0);
  });

  test("agent presence indicator flips to live on notesUpdated", async ({
    page,
    view,
  }) => {
    // Default state: no presence element at all (nothing has happened yet).
    await expect(page.locator(".agent-presence")).toHaveCount(0);

    await view.dispatch({
      type: "event",
      payload: { type: "notesUpdated", notes: [concernNote()] },
    });

    const presence = page.locator(".agent-presence");
    await expect(presence).toBeVisible();
    // We expect `.agent-live` within the first few seconds of arrival.
    await expect(presence).toHaveClass(/agent-live/);
    await expect(presence).toContainText(/claude/);
  });

  test("screenshot: spotlight pulses on the concerning tile", async ({
    page,
    view,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await view.dispatch({
      type: "event",
      payload: { type: "notesUpdated", notes: [concernNote(), intentNote()] },
    });
    // Pause at the ring's brightest frame so the screenshot shows a
    // clearly saturated pulse.
    await page.waitForTimeout(1050);
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page
      .locator(".panel-treemap")
      .screenshot({ path: path.join(SHOTS_DIR, "spotlight.png") });
    expect(fs.existsSync(path.join(SHOTS_DIR, "spotlight.png"))).toBe(true);
  });

  test("screenshot: focus mode dims the rest of the workspace", async ({
    page,
    view,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await view.dispatch({
      type: "event",
      payload: { type: "notesUpdated", notes: [concernNote(), intentNote()] },
    });
    await page.locator(".vibe-row.note-concern").click();
    await page.waitForTimeout(200);
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page
      .locator(".panel-treemap")
      .screenshot({ path: path.join(SHOTS_DIR, "focus.png") });
    expect(fs.existsSync(path.join(SHOTS_DIR, "focus.png"))).toBe(true);
  });

  test("screenshot: header with live agent presence", async ({
    page,
    view,
  }) => {
    await page.setViewportSize({ width: 1280, height: 200 });
    await view.dispatch({
      type: "event",
      payload: { type: "notesUpdated", notes: [concernNote()] },
    });
    await page.waitForTimeout(300);
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page
      .locator(".app-header")
      .screenshot({ path: path.join(SHOTS_DIR, "presence.png") });
    expect(fs.existsSync(path.join(SHOTS_DIR, "presence.png"))).toBe(true);
  });

  test("screenshot: full sidebar in focus mode (integrated view)", async ({
    page,
    view,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1600 });
    await view.dispatch({
      type: "event",
      payload: {
        type: "notesUpdated",
        notes: [
          concernNote(),
          intentNote(),
          {
            id: "n-q",
            kind: "question",
            title: "Extract retry logic into tenacity?",
            body: "",
            author: "claude",
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    // Flip into focus mode so the screenshot includes the dim + ring.
    await page.locator(".vibe-row.note-concern").click();
    await page.waitForTimeout(400);
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SHOTS_DIR, "focus-full.png"),
      fullPage: true,
    });
    expect(fs.existsSync(path.join(SHOTS_DIR, "focus-full.png"))).toBe(true);
  });
});
