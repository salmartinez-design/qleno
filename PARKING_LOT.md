# Parking Lot

Deferred items that are not code bugs. Workstation issues, infrastructure cleanup, tooling debt, and other things that do not block shipping but should be revisited. See KNOWN_BUGS.md for code level bugs.


## Local dev environment broken on macOS Apple Silicon

**Status:** Deferred. Not blocking deploys. Tenants unaffected.

**Symptom:** pnpm run dev and pnpm run build both fail with missing native binaries (@rollup/rollup-darwin-arm64, lightningcss.darwin-arm64.node) on Sal's workstation. Railway Linux builds are unaffected and deploy cleanly.

**Root cause:** pnpm 10.33 plus Node 24.14.1 does not reliably resolve platform specific optional dependencies for darwin-arm64. esbuild falls back to npm and recovers. rollup and lightningcss do not.

**Fix path:** Estimated 30 minutes.
1. Install Homebrew
2. brew install fnm
3. fnm install 20 and fnm use 20
4. Reinstall pnpm under Node 20
5. Wipe node_modules across all workspaces, pnpm store prune, pnpm install
6. Verify pnpm run dev boots on artifacts/qleno

**Why deferred:** Working through Claude Code, no local smoke testing needed today. Railway preview provides runtime verification. Fix when local development becomes friction.

**Date deferred:** April 28, 2026
