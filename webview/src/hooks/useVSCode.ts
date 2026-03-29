import { useCallback, useEffect, useRef } from 'react';
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from '../types';

interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeAPI;

let vscodeApi: VSCodeAPI | undefined;

function getApi(): VSCodeAPI | undefined {
  if (!vscodeApi) {
    try {
      vscodeApi = acquireVsCodeApi();
    } catch {
      console.warn('IVE: acquireVsCodeApi not available (running outside VSCode?)');
    }
  }
  return vscodeApi;
}

export function useVSCode(onMessage?: (msg: ExtensionToWebviewMessage) => void) {
  const callbackRef = useRef(onMessage);
  callbackRef.current = onMessage;

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      console.log('IVE webview received:', msg?.type, msg);
      callbackRef.current?.(msg as ExtensionToWebviewMessage);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const postMessage = useCallback((msg: WebviewToExtensionMessage) => {
    console.log('IVE webview sending:', msg.type);
    const api = getApi();
    if (api) {
      api.postMessage(msg);
    } else {
      console.warn('IVE: Cannot post message, no VSCode API');
    }
  }, []);

  return { postMessage };
}
