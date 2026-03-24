import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { requireAuth, signToken } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";

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

    const user = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase().trim()))
      .limit(1);

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

    const token = signToken({
      userId: user[0].id,
      companyId: user[0].company_id,
      role: user[0].role,
      email: user[0].email,
      first_name: user[0].first_name ?? undefined,
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
