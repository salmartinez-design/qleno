import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, userCompaniesTable, companiesTable } from "@workspace/db/schema";
import { eq, sql, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { requireAuth, signToken } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { sendNotification } from "../services/notificationService.js";

const router = Router();

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Bad Request", message: "Email and password required" });
    }
    if (typeof email !== "string" || email.length > 255) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid email" });
    }

    const rawResult = await db.execute(
      sql`SELECT * FROM users WHERE email = ${email.toLowerCase().trim()} LIMIT 1`
    );
    const user = rawResult.rows as any[];

    if (!user[0]) {
      await logAudit(req, "login_failed", "user", null, null, { email, reason: "user_not_found" });
      return res.status(401).json({ error: "Unauthorized", message: "Invalid credentials" });
    }

    // [login-diagnostics 2026-06-10] An imported/invited account can have a
    // NULL password_hash (never set). bcrypt.compare(pw, null) THROWS, which
    // surfaced as a 500 masked by the login page's generic message — making
    // it look like "wrong password" when really no password exists. Detect it
    // explicitly and tell the operator the real cause.
    if (!user[0].password_hash) {
      await logAudit(req, "login_failed", "user", user[0].id, null, { email, reason: "no_password_set" });
      return res.status(401).json({ error: "Unauthorized", message: "No password set for this account yet. The office needs to set or reset your password." });
    }

    const validPassword = await bcrypt.compare(password, user[0].password_hash);
    if (!validPassword) {
      await logAudit(req, "login_failed", "user", user[0].id, null, { email, reason: "wrong_password" });
      return res.status(401).json({ error: "Unauthorized", message: "Invalid credentials" });
    }

    if (!user[0].is_active) {
      return res.status(401).json({ error: "Unauthorized", message: "Account is inactive" });
    }

    const isSuperAdminFlag = user[0].is_super_admin === true || user[0].is_super_admin === 't';

    const token = signToken({
      userId: user[0].id,
      companyId: user[0].company_id,
      role: user[0].role,
      email: user[0].email,
      first_name: user[0].first_name ?? undefined,
      isSuperAdmin: isSuperAdminFlag,
    });

    // 2026-05-20: stamp last_login_at on every successful login. Used by
    // the LMS admin roster to surface "did this person open the app at
    // all" (distinct from quiz-submit-only `lms_enrollments.last_activity_at`).
    try {
      await db.execute(
        sql`UPDATE users SET last_login_at = NOW() WHERE id = ${user[0].id}`,
      );
    } catch (err) {
      // Non-fatal: a stamp failure must not block the login response.
      console.error("[auth] last_login_at update failed:", err);
    }

    await logAudit(req, "login_success", "user", user[0].id, null, { email });

    // Fetch all companies this user can access via user_companies join table
    let availableCompanies: { id: number; name: string }[] = [];
    try {
      const companyRows = await db
        .select({ id: companiesTable.id, name: companiesTable.name })
        .from(userCompaniesTable)
        .innerJoin(companiesTable, eq(userCompaniesTable.company_id, companiesTable.id))
        .where(eq(userCompaniesTable.user_id, user[0].id));
      availableCompanies = companyRows;
    } catch {
      // user_companies table may not exist yet (first deploy before migration runs)
    }

    return res.json({
      token,
      user: {
        id: user[0].id,
        email: user[0].email,
        first_name: user[0].first_name,
        last_name: user[0].last_name,
        role: user[0].role,
        company_id: user[0].company_id,
        avatar_url: user[0].avatar_url,
        is_super_admin: isSuperAdminFlag,
      },
      available_companies: availableCompanies,
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Login failed" });
  }
});

router.post("/logout", requireAuth, async (req, res) => {
  await logAudit(req, "logout", "user", req.auth!.userId);
  return res.json({ success: true, message: "Logged out" });
});

router.post("/refresh", requireAuth, (req, res) => {
  try {
    const newToken = signToken({
      userId: req.auth!.userId,
      companyId: req.auth!.companyId,
      role: req.auth!.role,
      email: req.auth!.email,
      first_name: req.auth!.first_name,
    });
    return res.json({ token: newToken });
  } catch (err) {
    console.error("Token refresh error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Bad Request", message: "Current and new password required" });
    }
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ error: "Bad Request", message: "New password must be at least 6 characters" });
    }

    const user = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.auth!.userId))
      .limit(1);

    if (!user[0]) {
      return res.status(404).json({ error: "Not Found", message: "User not found" });
    }

    const valid = await bcrypt.compare(currentPassword, user[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Unauthorized", message: "Current password is incorrect" });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db
      .update(usersTable)
      .set({ password_hash: newHash } as any)
      .where(eq(usersTable.id, req.auth!.userId));

    await logAudit(req, "password_changed", "user", req.auth!.userId);
    return res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("Change password error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to change password" });
  }
});

// ── FORGOT PASSWORD ──────────────────────────────────────────────────────────
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Bad Request", message: "Email required" });
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase().trim())).limit(1);
    // Always return success to avoid user enumeration
    if (!user) return res.json({ success: true, message: "If that email exists, a reset link has been sent." });

    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Raw SQL: reset_token / reset_token_expires_at are real DB columns but are
    // NOT in the drizzle usersTable schema, so db.update().set({reset_token})
    // throws (unmappable key) and 500s before any email send. The columns exist
    // in Postgres, so write them directly.
    await db.execute(
      sql`UPDATE users SET reset_token = ${token}, reset_token_expires_at = ${expires} WHERE id = ${user.id}`,
    );

    const resetLink = `https://app.qleno.com/reset-password?token=${token}`;
    const mv = {
      first_name:   user.first_name || "",
      reset_link:   resetLink,
      reset_expiry: "1 hour",
    };
    // transactional=true → always sends (bypasses the comms gates); a password
    // reset is user-initiated and must reach them regardless of marketing gating.
    await sendNotification("password_reset", "email", user.company_id, user.email, null, mv, true);

    return res.json({ success: true, message: "If that email exists, a reset link has been sent." });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to process request" });
  }
});

// ── RESET PASSWORD ────────────────────────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "Bad Request", message: "Valid token and password (min 6 chars) required" });
    }

    // Raw SQL: reset_token columns aren't in the drizzle schema (see
    // forgot-password). Look the token up directly.
    const tokenLookup = await db.execute(
      sql`SELECT * FROM users WHERE reset_token = ${token} LIMIT 1`,
    );
    const user = (tokenLookup.rows as any[])[0];

    if (!user || !user.reset_token_expires_at || new Date(user.reset_token_expires_at) < new Date()) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid or expired reset token" });
    }

    const hash = await bcrypt.hash(password, 10);
    await db.execute(
      sql`UPDATE users SET password_hash = ${hash}, reset_token = NULL, reset_token_expires_at = NULL WHERE id = ${user.id}`,
    );

    await logAudit(req, "password_reset", "user", user.id);
    return res.json({ success: true, message: "Password reset successfully. You can now log in." });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to reset password" });
  }
});

// ── SWITCH COMPANY ────────────────────────────────────────────────────────────
router.post("/switch-company", requireAuth, async (req, res) => {
  try {
    const { company_id } = req.body;
    if (!company_id || typeof company_id !== "number") {
      return res.status(400).json({ error: "Bad Request", message: "company_id (number) required" });
    }

    // Verify the requesting user has access to this company
    const membership = await db
      .select({ role: userCompaniesTable.role })
      .from(userCompaniesTable)
      .where(
        and(
          eq(userCompaniesTable.user_id, req.auth!.userId),
          eq(userCompaniesTable.company_id, company_id)
        )
      )
      .limit(1);

    if (!membership[0]) {
      return res.status(403).json({ error: "Forbidden", message: "No access to that company" });
    }

    // Look up the user's full record so we preserve role/name in the new token
    const user = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.auth!.userId))
      .limit(1);

    if (!user[0]) {
      return res.status(404).json({ error: "Not Found", message: "User not found" });
    }

    const isSuperAdminFlag = user[0].is_super_admin === true || (user[0] as any).is_super_admin === 't';

    const newToken = signToken({
      userId: user[0].id,
      companyId: company_id,
      role: user[0].role,
      email: user[0].email,
      first_name: user[0].first_name ?? undefined,
      isSuperAdmin: isSuperAdminFlag,
    });

    // Fetch company details for the response
    const company = await db
      .select({ id: companiesTable.id, name: companiesTable.name })
      .from(companiesTable)
      .where(eq(companiesTable.id, company_id))
      .limit(1);

    // Fetch all available companies for convenience
    const availableCompanies = await db
      .select({ id: companiesTable.id, name: companiesTable.name })
      .from(userCompaniesTable)
      .innerJoin(companiesTable, eq(userCompaniesTable.company_id, companiesTable.id))
      .where(eq(userCompaniesTable.user_id, req.auth!.userId));

    await logAudit(req, "company_switch", "company", company_id, null, { from: req.auth!.companyId, to: company_id });

    return res.json({
      token: newToken,
      user: {
        id: user[0].id,
        email: user[0].email,
        first_name: user[0].first_name,
        last_name: user[0].last_name,
        role: user[0].role,
        company_id,
        avatar_url: user[0].avatar_url,
        is_super_admin: isSuperAdminFlag,
      },
      company: company[0] ?? null,
      available_companies: availableCompanies,
    });
  } catch (err) {
    console.error("Switch company error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to switch company" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.auth!.userId))
      .limit(1);

    if (!user[0]) {
      return res.status(404).json({ error: "Not Found", message: "User not found" });
    }

    return res.json({
      id: user[0].id,
      email: user[0].email,
      first_name: user[0].first_name,
      last_name: user[0].last_name,
      role: user[0].role,
      company_id: user[0].company_id,
      avatar_url: user[0].avatar_url,
    });
  } catch (err) {
    console.error("Get me error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get user" });
  }
});

export default router;
