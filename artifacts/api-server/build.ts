import path from "path";
import { fileURLToPath } from "url";
import { build as esbuild } from "esbuild";
import { rm, readFile } from "fs/promises";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times without risking some
// packages that are not bundle compatible
const allowlist = [
  "@google/generative-ai",
  "axios",
  "bcryptjs",
  "connect-pg-simple",
  "cookie-parser",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  const distDir = path.resolve(__dirname, "dist");
  await rm(distDir, { recursive: true, force: true });

  // Push DB schema to production database (idempotent, safe to run every build)
  if (process.env.DATABASE_URL) {
    // Step 1: pre-convert additional_pay.type from enum→text if needed.
    // This runs BEFORE drizzle-kit push so drizzle sees the column already
    // as text and generates no diff — preventing the DROP TYPE error.
    // Uses @workspace/db so the pg module resolves correctly.
    try {
      execSync("pnpm --filter @workspace/db run pre-push-fix", {
        stdio: "inherit",
        cwd: path.resolve(__dirname, "../.."),
        timeout: 30000,
      });
    } catch (e) {
      console.warn("pre-push-fix failed (non-fatal):", e);
    }

    // Step 2: push schema — column is now already text so drizzle generates no diff
    console.log("pushing database schema...");
    try {
      execSync("pnpm --filter @workspace/db run push-force", {
        stdio: "inherit",
        cwd: path.resolve(__dirname, "../.."),
        timeout: 60000, // 60s timeout — prevents hanging on enum migrations
      });
      console.log("schema push complete");
    } catch (e) {
      console.warn("schema push failed (non-fatal):", e);
    }
  }

  // Build frontend — output lands at artifacts/cleanops-pro/dist/public
  // The Express server serves it as static files in production (see app.ts)
  console.log("building frontend...");
  try {
    execSync("pnpm --filter @workspace/cleanops-pro run build", {
      stdio: "inherit",
      cwd: path.resolve(__dirname, "../.."),
    });
    console.log("frontend build complete");
  } catch (e) {
    console.error("frontend build failed:", e);
    process.exit(1);
  }

  console.log("building server...");
  const pkgPath = path.resolve(__dirname, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter(
    (dep) =>
      !allowlist.includes(dep) &&
      !(pkg.dependencies?.[dep]?.startsWith("workspace:")),
  );

  await esbuild({
    entryPoints: [path.resolve(__dirname, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile: path.resolve(distDir, "index.mjs"),
    banner: {
      js: `import{createRequire}from"module";const require=createRequire(import.meta.url);`,
    },
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
