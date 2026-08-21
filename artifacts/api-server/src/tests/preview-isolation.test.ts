import { test } from "node:test";
import assert from "node:assert/strict";

// The guard reads RAILWAY_ENVIRONMENT into module-level consts, so each case has
// to set the environment and then load a fresh copy of the module. A unique
// query string is what defeats the ESM module cache.
let loadCount = 0;
async function loadGuard(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import(`../lib/preview-guard.js?case=${loadCount++}`);
  return { mod, restore: () => { process.env = saved; } };
}

function fakeReq(method: string, path: string) {
  return { method, path } as any;
}

function fakeRes() {
  const out: any = { statusCode: null, body: null };
  out.status = (code: number) => { out.statusCode = code; return out; };
  out.json = (body: any) => { out.body = body; return out; };
  return out;
}

test("a PR preview is read-only, and says why", async () => {
  const { mod, restore } = await loadGuard({ RAILWAY_ENVIRONMENT: "qleno-pr-1506", PREVIEW_ALLOW_WRITES: undefined });
  try {
    assert.equal(mod.IS_RAILWAY_PREVIEW, true);
    assert.equal(mod.IS_RAILWAY_PRODUCTION, false);

    const res = fakeRes();
    let nexted = false;
    mod.previewReadOnlyGuard(fakeReq("POST", "/api/jobs"), res, () => { nexted = true; });
    assert.equal(nexted, false, "a write must not reach the route");
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.environment, "qleno-pr-1506");
  } finally { restore(); }
});

test("a PR preview still serves reads and still lets someone sign in", async () => {
  const { mod, restore } = await loadGuard({ RAILWAY_ENVIRONMENT: "qleno-pr-1506", PREVIEW_ALLOW_WRITES: undefined });
  try {
    for (const [method, path] of [
      ["GET", "/api/jobs"],
      ["HEAD", "/api/health"],
      ["POST", "/api/auth/login"],
      ["POST", "/api/auth/refresh"],
      ["POST", "/api/portal/auth/login"],
    ] as Array<[string, string]>) {
      let nexted = false;
      mod.previewReadOnlyGuard(fakeReq(method, path), fakeRes(), () => { nexted = true; });
      assert.equal(nexted, true, `${method} ${path} should pass`);
    }
  } finally { restore(); }
});

test("password reset and portal invite are NOT in the sign-in allowlist", async () => {
  const { mod, restore } = await loadGuard({ RAILWAY_ENVIRONMENT: "qleno-pr-1506", PREVIEW_ALLOW_WRITES: undefined });
  try {
    for (const path of ["/api/auth/forgot-password", "/api/auth/reset-password", "/api/portal/auth/invite", "/api/portal/auth/set-password"]) {
      const res = fakeRes();
      let nexted = false;
      mod.previewReadOnlyGuard(fakeReq("POST", path), res, () => { nexted = true; });
      assert.equal(nexted, false, `${path} sends mail or changes a credential — must stay blocked`);
      assert.equal(res.statusCode, 503);
    }
  } finally { restore(); }
});

test("production is untouched — writes pass, workers run, credentials survive", async () => {
  const { mod, restore } = await loadGuard({
    RAILWAY_ENVIRONMENT: "production",
    RESEND_API_KEY: "re_live_key",
    STRIPE_SECRET_KEY: "sk_live_key",
    TWILIO_AUTH_TOKEN: "tw_live_token",
    SQUARE_ACCESS_TOKEN: "sq_live_token",
  });
  try {
    let nexted = false;
    mod.previewReadOnlyGuard(fakeReq("POST", "/api/jobs"), fakeRes(), () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(mod.backgroundWorkersAllowed(), true);
    assert.deepEqual(mod.neutralizeLiveCredentials(), []);
    assert.equal(process.env.RESEND_API_KEY, "re_live_key");
    assert.equal(process.env.STRIPE_SECRET_KEY, "sk_live_key");
  } finally { restore(); }
});

test("a laptop is not a preview — no RAILWAY_ENVIRONMENT means the guard stays out of the way", async () => {
  const { mod, restore } = await loadGuard({ RAILWAY_ENVIRONMENT: undefined, RESEND_API_KEY: "re_local" });
  try {
    assert.equal(mod.IS_RAILWAY_PREVIEW, false);
    let nexted = false;
    mod.previewReadOnlyGuard(fakeReq("POST", "/api/jobs"), fakeRes(), () => { nexted = true; });
    assert.equal(nexted, true);
    assert.deepEqual(mod.neutralizeLiveCredentials(), []);
    assert.equal(process.env.RESEND_API_KEY, "re_local");
  } finally { restore(); }
});

test("a preview loses every live sender key", async () => {
  const { mod, restore } = await loadGuard({
    RAILWAY_ENVIRONMENT: "qleno-pr-1529",
    RESEND_API_KEY: "re_live_key",
    STRIPE_SECRET_KEY: "sk_live_key",
    TWILIO_ACCOUNT_SID: "AC_live",
    TWILIO_AUTH_TOKEN: "tw_live_token",
    SQUARE_ACCESS_TOKEN: "sq_live_token",
    SQUARE_WEBHOOK_SIGNATURE_KEY: "sq_sig",
    DATABASE_URL: "postgres://prod",
  });
  try {
    const cleared = mod.neutralizeLiveCredentials();
    for (const name of ["RESEND_API_KEY", "STRIPE_SECRET_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "SQUARE_ACCESS_TOKEN", "SQUARE_WEBHOOK_SIGNATURE_KEY"]) {
      assert.ok(cleared.includes(name), `${name} should have been cleared`);
      assert.equal(process.env[name], undefined);
    }
    // DATABASE_URL is deliberately left alone: the preview still has to read.
    assert.equal(process.env.DATABASE_URL, "postgres://prod");
  } finally { restore(); }
});

test("PREVIEW_ALLOW_WRITES re-opens the database but never the senders", async () => {
  const { mod, restore } = await loadGuard({
    RAILWAY_ENVIRONMENT: "qleno-pr-1506",
    PREVIEW_ALLOW_WRITES: "true",
    RESEND_API_KEY: "re_live_key",
    TWILIO_AUTH_TOKEN: "tw_live_token",
  });
  try {
    let nexted = false;
    mod.previewReadOnlyGuard(fakeReq("POST", "/api/jobs"), fakeRes(), () => { nexted = true; });
    assert.equal(nexted, true, "the escape hatch should let the write through");

    mod.neutralizeLiveCredentials();
    assert.equal(process.env.RESEND_API_KEY, undefined, "the escape hatch must NOT hand back a live email key");
    assert.equal(process.env.TWILIO_AUTH_TOKEN, undefined, "the escape hatch must NOT hand back a live SMS key");
    assert.equal(mod.backgroundWorkersAllowed(), false, "the escape hatch must NOT start the crons");
  } finally { restore(); }
});
