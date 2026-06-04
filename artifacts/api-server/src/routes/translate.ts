import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth, requireRole } from "../lib/auth.js";

// [translate-job-notes 2026-05-27] Office types Job Notes in English; some
// Phes techs are more comfortable in Spanish. One-click translation via
// Claude gives the same text in Spanish that the tech sees alongside the
// English original. Office-only — customer-facing fields don't route here.
//
// Requires ANTHROPIC_API_KEY in Railway env. If missing, we surface a
// clear error instead of a 500 so the operator knows to set it.

const router = Router();

const MAX_INPUT_CHARS = 5000;
const SUPPORTED_TARGETS = new Set(["es", "en"]);
const LANG_NAME: Record<string, string> = { es: "Spanish", en: "English" };

router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const target = typeof req.body?.target === "string" ? req.body.target : "es";

    if (!text.trim()) { res.status(400).json({ error: "text required" }); return; }
    if (text.length > MAX_INPUT_CHARS) {
      res.status(400).json({ error: `text exceeds ${MAX_INPUT_CHARS} chars` });
      return;
    }
    if (!SUPPORTED_TARGETS.has(target)) {
      res.status(400).json({ error: `target must be one of: ${[...SUPPORTED_TARGETS].join(", ")}` });
      return;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("[translate] ANTHROPIC_API_KEY not set — translation disabled");
      res.status(503).json({ error: "Translation is not configured — set ANTHROPIC_API_KEY in Railway" });
      return;
    }

    const client = new Anthropic();
    const targetName = LANG_NAME[target];

    // System prompt keeps the model focused on the narrow task. Avoids the
    // common failure where the model "answers" the note instead of
    // translating it (e.g. instructions to the tech turn into the model
    // doing the work).
    const system =
      `You are a translation engine for a residential cleaning company's internal job notes. ` +
      `Translate the user's text into ${targetName}. Output ONLY the translated text — no quotes, no commentary, no preamble. ` +
      `Preserve numbers, addresses, names, and codes verbatim. Maintain line breaks and formatting. ` +
      `Use cleaning-industry vocabulary that a Mexican-Spanish-speaking technician would understand naturally.`;

    const response = await client.messages.create({
      // Haiku — note translation is a simple task; Haiku is far cheaper and
      // faster than Opus with no quality loss for short job notes.
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: text }],
    });

    // Concatenate text blocks — there should typically be just one, but
    // join defensively in case the model emits multiple.
    const translated = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();

    if (!translated) {
      res.status(502).json({ error: "Translation returned empty result" });
      return;
    }

    res.json({
      translated,
      target,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });
  } catch (e: any) {
    if (e instanceof Anthropic.AuthenticationError) {
      console.error("[translate] Auth error:", e.message);
      res.status(503).json({ error: "Translation auth failed — check ANTHROPIC_API_KEY" });
      return;
    }
    if (e instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: "Translation temporarily rate-limited — try again in a moment" });
      return;
    }
    console.error("[translate] Error:", e);
    res.status(500).json({ error: "Translation failed", message: e?.message });
  }
});

export default router;
