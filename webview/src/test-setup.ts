// jsdom doesn't ship ResizeObserver; shim it so components that observe
// element size (Treemap) don't blow up in unit tests. Playwright runs
// against a real browser so it uses the native one.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;
