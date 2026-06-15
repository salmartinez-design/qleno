// Patch fetch for the Capacitor native shell BEFORE any app module loads, so
// the first API call (and everything after) hits the real API origin. No-op on
// web. Must stay the first import.
import { installNativeApiBridge } from "./lib/native-bridge";
installNativeApiBridge();

import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initNativePush } from "./lib/native-push";

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
