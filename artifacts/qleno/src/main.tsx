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
