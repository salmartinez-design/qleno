import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
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

    await logAudit(req, "login_success", "user", user[0].id, null, { email });

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

    await db.update(usersTable)
      .set({ reset_token: token, reset_token_expires_at: expires } as any)
      .where(eq(usersTable.id, user.id));

    const resetLink = `https://clean-ops-pro.replit.app/reset-password?token=${token}`;
    const mv = {
      first_name:   user.first_name || "",
      reset_link:   resetLink,
      reset_expiry: "1 hour",
    };
    await sendNotification("password_reset", "email", user.company_id, user.email, null, mv);

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

    const [user] = await db.select().from(usersTable)
      .where(eq((usersTable as any).reset_token, token)).limit(1);

    if (!user || !(user as any).reset_token_expires_at || new Date((user as any).reset_token_expires_at) < new Date()) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid or expired reset token" });
    }

    const hash = await bcrypt.hash(password, 10);
    await db.update(usersTable)
      .set({ password_hash: hash, reset_token: null, reset_token_expires_at: null } as any)
      .where(eq(usersTable.id, user.id));

    await logAudit(req, "password_reset", "user", user.id);
    return res.json({ success: true, message: "Password reset successfully. You can now log in." });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to reset password" });
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
