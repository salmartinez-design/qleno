import type { CapacitorConfig } from "@capacitor/cli";

// Qleno native shell (iOS + Android) built from the Vite web bundle.
// The web assets in `dist/public` are bundled into the app; API calls hit the
// production Railway origin via the fetch shim in src/lib/native-bridge.ts.
const config: CapacitorConfig = {
  appId: "io.phes.qleno",
  appName: "Qleno",
  webDir: "dist/public",
  backgroundColor: "#F7F6F3",
  ios: {
    // Respect the notch/Dynamic Island; the web layout owns its own padding.
    contentInset: "always",
    backgroundColor: "#F7F6F3",
  },
  android: {
    backgroundColor: "#F7F6F3",
  },
  plugins: {
    PushNotifications: {
      // Show banners/badges/sounds while the app is foregrounded.
      presentationOptions: ["badge", "sound", "alert"],
    },
    SplashScreen: {
      launchShowDuration: 700,
      backgroundColor: "#0A0E1A",
      showSpinner: false,
    },
  },
};

export default config;
