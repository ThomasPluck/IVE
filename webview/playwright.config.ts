import { defineConfig, devices } from "@playwright/test";

// Serve the built webview bundle from `../extension/dist/webview/`. The
// test harness replaces the index.html's `acquireVsCodeApi` shim and
// dispatches message events to drive the webview the same way the
// extension host would.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 20_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    // Vite preview picks up the build.outDir from vite.config.ts, which
    // resolves to ../extension/dist/webview — the production bundle the
    // VSCode webview actually loads.
    command: "npx vite preview --port 4173 --strictPort",
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
