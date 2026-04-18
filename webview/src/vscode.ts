// Thin wrapper over VSCode's acquireVsCodeApi() so the rest of the UI
// never has to depend on the global, and tests can stub it trivially.

declare global {
  interface Window {
    acquireVsCodeApi?: <T = unknown>() => {
      postMessage: (m: unknown) => void;
      getState: () => T | undefined;
      setState: (s: T) => void;
    };
  }
}

let cached: ReturnType<NonNullable<Window["acquireVsCodeApi"]>> | null = null;

export interface VsApi {
  postMessage: (m: unknown) => void;
  getState: () => unknown;
  setState: (s: unknown) => void;
}

export function vs(): VsApi {
  if (!cached) {
    if (typeof window !== "undefined" && window.acquireVsCodeApi) {
      cached = window.acquireVsCodeApi();
    } else {
      // Dev / test fallback: no-op.
      cached = {
        postMessage: () => undefined,
        getState: () => undefined,
        setState: () => undefined,
      };
    }
  }
  return cached!;
}
