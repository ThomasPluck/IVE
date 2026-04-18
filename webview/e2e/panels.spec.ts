// End-to-end Playwright tests for the IVE webview.
//
// Drives the built bundle under a real browser — no jsdom shortcuts.
// Every panel is asserted visible, every interactive surface is
// clicked, keyboard navigation is exercised, and the error-state
// branches fire on synthesised rpcError payloads.

import { test, expect, defaultWorkspaceState } from "./fixtures";

test.describe("IVE webview", () => {
  test("all four panels land visible after a workspaceState dispatch", async ({
    page,
    view,
  }) => {
    await expect(page.locator(".panel-treemap")).toBeVisible();
    await expect(page.locator(".panel-diagnostics")).toBeVisible();
    await expect(page.locator(".panel-summary")).toBeVisible();
    await expect(page.locator(".panel-slice")).toBeVisible();
    await expect(page.locator(".brand")).toHaveText("IVE");
    // capabilities.cpg.available = false → "Degraded: cpg" banner.
    await expect(page.getByText(/Degraded:.*cpg/)).toBeVisible();
    view;
  });

  test("treemap tiles are present and clickable", async ({ page, view }) => {
    void view;
    const rects = page.locator(".treemap svg rect");
    await expect(rects.first()).toBeVisible();
    const count = await rects.count();
    expect(count).toBeGreaterThanOrEqual(2);
    // Dispatch a native click via page.mouse at the tile's centre. SVG
    // element locators' bounding boxes are reliable and avoid the
    // React-synthetic-event-on-<g> quirk we'd hit with .click() directly
    // on a decorative <rect>.
    const box = await rects.first().boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await expect(page.locator(".crumb.active")).toBeVisible();
  });

  test("breadcrumb navigates back to workspace after drilling down", async ({
    page,
    view,
  }) => {
    void view;
    const breadcrumb = page.locator(".breadcrumb");
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb).toHaveText(/workspace/);
    const box = await page.locator(".treemap svg rect").first().boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".crumb.active")).toBeVisible();
    await page.locator(".crumb", { hasText: "workspace" }).click();
    await expect(page.locator(".crumb.active")).toHaveCount(0);
  });


  test("diagnostics panel: critical row renders with fix button", async ({
    page,
    view,
  }) => {
    void view;
    const row = page
      .locator(".diag.severity-critical")
      .filter({ hasText: "huggingface_utils" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: /fix:/ })).toBeVisible();
  });

  test("applyFix button posts the fix payload to the host", async ({
    page,
    view,
  }) => {
    await view.clearOutgoing();
    await page.getByRole("button", { name: /Delete `import huggingface_utils`/ }).click();
    const outgoing = await view.outgoing();
    const applyFix = (outgoing as { type: string }[]).find((m) => m.type === "applyFix");
    expect(applyFix).toBeDefined();
  });

  test("j/k keyboard navigation moves the selection; Enter posts openFile", async ({
    page,
    view,
  }) => {
    const list = page.locator(".diagnostics");
    await list.focus();
    // First row selected by default.
    const selected = page.locator(".diag.selected");
    await expect(selected).toHaveCount(1);
    const firstMessage = (await selected.textContent()) ?? "";

    await page.keyboard.press("j");
    const secondMessage = (await page.locator(".diag.selected").textContent()) ?? "";
    expect(secondMessage).not.toBe(firstMessage);

    await view.clearOutgoing();
    await page.keyboard.press("Enter");
    const outgoing = await view.outgoing();
    expect(outgoing.some((m: any) => m.type === "openFile")).toBeTruthy();
  });

  test("filter chip toggle narrows the visible diagnostics", async ({
    page,
    view,
  }) => {
    void view;
    const pyrightChip = page.locator(".chip", { hasText: "pyright" });
    await expect(pyrightChip).toBeVisible();
    await pyrightChip.click();
    // When pyright is the sole active filter, ive-hallucination rows hide.
    await expect(
      page.locator(".diag", { hasText: "huggingface_utils" }),
    ).toHaveCount(0);
    await expect(
      page.locator(".diag", { hasText: "unknown member" }),
    ).toBeVisible();
    // Click again to release the filter.
    await pyrightChip.click();
    await expect(
      page.locator(".diag", { hasText: "huggingface_utils" }),
    ).toBeVisible();
  });

  test("summary panel button clicks post a summarize request", async ({ page, view }) => {
    await view.clearOutgoing();
    await page.getByRole("button", { name: /summarize worst/ }).click();
    const outgoing = await view.outgoing();
    const summarize = (outgoing as { type: string }[]).find(
      (m) => m.type === "summarize",
    );
    expect(summarize).toBeDefined();
  });

  test("summary renders facts + struck-through unentailed claims on rpcResult", async ({
    page,
    view,
  }) => {
    await view.dispatch({
      type: "rpcResult",
      id: -1,
      result: {
        symbol: "slop.fetch",
        text: "",
        factsGiven: [
          { id: "f1", kind: "call", content: "calls requests.get" },
        ],
        claims: [
          {
            text: "Fetches the url with requests.get",
            entailed: true,
            supportingFactIds: ["f1"],
          },
          {
            text: "Persists to Redis",
            entailed: false,
            supportingFactIds: [],
            reason: "no supporting fact found",
          },
        ],
        model: "ive-offline",
        generatedAt: "2026-04-17T00:00:00Z",
      },
    });
    await expect(page.locator(".claim-ok")).toContainText(/Fetches/);
    await expect(page.locator(".claim-bad")).toContainText(/Redis/);
    await expect(page.locator(".facts")).toContainText(/calls requests.get/);
  });

  test("summary error surfaces per-panel, global banner stays silent", async ({
    page,
    view,
  }) => {
    await view.dispatch({
      type: "rpcError",
      id: -1,
      error: { code: -32000, message: "no API key" },
    });
    await expect(
      page
        .locator(".panel-summary .panel-error")
        .filter({ hasText: "no API key" }),
    ).toBeVisible();
    // Global banner must remain silent.
    await expect(page.locator(".banner-error")).toHaveCount(0);
  });

  test("slice panel shows degraded hint when CPG is unavailable", async ({
    page,
    view,
  }) => {
    void view;
    const slice = page.locator(".panel-slice");
    await expect(slice).toBeVisible();
    await expect(slice.getByText(/Cross-file slicing unavailable/)).toBeVisible();
  });

  test("slice rpcResult renders the chain with origin dot + row", async ({
    page,
    view,
  }) => {
    await view.dispatch({
      type: "rpcResult",
      id: -2,
      result: {
        request: {
          origin: {
            file: "a.py",
            range: { start: [4, 11], end: [4, 11] },
          },
          direction: "backward",
          kind: "thin",
          crossFile: false,
        },
        nodes: [
          {
            id: 0,
            location: { file: "a.py", range: { start: [4, 4], end: [4, 20] } },
            label: "return result",
          },
          {
            id: 1,
            location: { file: "a.py", range: { start: [3, 4], end: [3, 22] } },
            label: "result = x + y",
          },
        ],
        edges: [{ from: 0, to: 1, kind: "data" }],
        truncated: false,
        elapsedMs: 4,
      },
    });

    const rows = page.locator(".slice-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("return result");
    // Clicking a slice row posts openFile.
    await view.clearOutgoing();
    await rows.first().click();
    const outgoing = await view.outgoing();
    expect(outgoing.some((m: any) => m.type === "openFile")).toBeTruthy();
  });

  test("indexing phase shows a progress bar that clears on ready", async ({
    page,
    view,
  }) => {
    // Flip back to indexing and emit progress.
    await view.dispatch({ type: "status", payload: { phase: "indexing" } });
    await view.dispatch({
      type: "event",
      payload: { type: "indexProgress", filesDone: 1, filesTotal: 4 },
    });
    await expect(page.locator("progress")).toBeVisible();

    // Hit ready via a fresh workspaceState.
    await view.dispatchWorkspaceState(defaultWorkspaceState());
    await expect(page.locator(".phase-ready")).toBeVisible();
  });
});
