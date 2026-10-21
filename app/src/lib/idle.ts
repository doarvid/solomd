/**
 * Run `fn` once startup has settled: after `delayMs`, then at the next idle
 * period (or after `timeoutMs` at the latest). For launch-time chores that
 * nobody is waiting on — an update check, a background probe — so they don't
 * compete with the first keystrokes. WebKit (macOS/iOS WKWebView, WebKitGTK)
 * has no requestIdleCallback; there it is just the delay.
 */
export function runWhenIdle(fn: () => void, delayMs = 1500, timeoutMs = 3000): void {
  setTimeout(() => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (typeof ric === 'function') ric(() => fn(), { timeout: timeoutMs });
    else fn();
  }, delayMs);
}
