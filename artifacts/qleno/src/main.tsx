// Patch fetch for the Capacitor native shell BEFORE any app module loads, so
// the first API call (and everything after) hits the real API origin. No-op on
// web. Must stay the first import.
import { installNativeApiBridge } from "./lib/native-bridge";
installNativeApiBridge();

import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initNativePush } from "./lib/native-push";
import { reloadForStaleChunk, isStaleChunkError } from "./components/error-boundary";

// [stale-chunk 2026-06-25] We deploy frequently. A tab still on the OLD bundle
// that navigates to a lazy route fetches a code chunk by its now-deleted
// filename and crashes with "Something went wrong". Vite fires vite:preloadError
// at the source — catch it and reload to the fresh bundle (guarded against
// loops). The unhandledrejection backstop catches any that slip past.
window.addEventListener("vite:preloadError", (e: Event) => {
  e.preventDefault();
  reloadForStaleChunk();
});
window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  if (isStaleChunkError(e.reason)) reloadForStaleChunk();
});

createRoot(document.getElementById("root")!).render(<App />);

// Register for push notifications in the native shell (no-op on web).
void initNativePush();

// Register the Web Push / PWA service worker (web only). Enables installability
// and lets the app receive push while closed. Registration is harmless without a
// push subscription; the actual subscribe happens from the Enable-Push UI.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("[sw] register failed", e));
  });
}
