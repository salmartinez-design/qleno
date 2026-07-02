import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "../lib/auth.js";

// [message-tone 2026-07-02] One-tap tone polish for outbound customer SMS.
// The office drafts a reply in the Messages thread, taps a tone, and Claude
// rewrites it to sound the way a cleaning company wants to sound to a client —
// without changing the facts. Same Claude setup as routes/translate.ts
// (ANTHROPIC_API_KEY, claude-haiku-4-5 — cheap + fast for short SMS). It only
// rewrites text supplied in the request; no tenant data is read, so there's
// nothing role-sensitive to gate beyond requireAuth.
//
// Requires ANTHROPIC_API_KEY in Railway env. If missing we surface a clear
// 503 so the operator knows to set it (mirrors translate.ts).

const router = Router();

const MAX_INPUT_CHARS = 2000; // SMS drafts are short; keep the model cheap.

// Each tone maps to a one-line instruction appended to the base system prompt.
// Keep the set small and unambiguous — this is a customer-service shop, not a
// style playground.
const TONES: Record<string, string> = {
  professional:
    "Rewrite it to sound warm, polished, and professional — the way a trusted local cleaning company would speak to a client. Courteous and clear, never stiff or corporate.",
  friendly:
    "Rewrite it to sound friendly and personable while staying professional — approachable and warm, like a helpful small-business owner texting a regular client.",
  concise:
    "Tighten it to the shortest clear version that keeps every fact and stays polite. Trim filler; keep it easy to read on a phone.",
  apologetic:
    "Rewrite it to lead with a sincere, brief apology and a reassuring, solution-focused tone — for when something went wrong (a miss, a delay, a complaint). Warm and accountable, not groveling.",
};

router.post("/", requireAuth, async (req, res) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const tone = typeof req.body?.tone === "string" ? req.body.tone : "professional";

    if (!text.trim()) { res.status(400).json({ error: "text required" }); return; }
    if (text.length > MAX_INPUT_CHARS) {
      res.status(400).json({ error: `text exceeds ${MAX_INPUT_CHARS} chars` });
      return;
    }
    if (!TONES[tone]) {
      res.status(400).json({ error: `tone must be one of: ${Object.keys(TONES).join(", ")}` });
      return;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("[message-tone] ANTHROPIC_API_KEY not set — tone polish disabled");
      res.status(503).json({ error: "AI tone is not configured — set ANTHROPIC_API_KEY in Railway" });
      return;
    }

    const client = new Anthropic();

    // System prompt pins the model to REWRITING the draft, not answering it or
    // inventing details — the classic failure where "ask them for the address"
    // turns into the model writing an address. Preserve facts verbatim; output
    // only the rewritten SMS so the FE can drop it straight into the composer.
    const system =
      `You are an editor for a residential cleaning company's outbound text messages to clients. ` +
      `You will be given a rough draft of ONE message. Rewrite it. ${TONES[tone]} ` +
      `Rules: Output ONLY the rewritten message text — no quotes, no options, no commentary, no preamble. ` +
      `Preserve all facts, names, dates, times, prices, and addresses EXACTLY — never invent or change them. ` +
      `Do not answer questions in the draft or add new information; only improve wording and tone. ` +
      `Keep it appropriate for SMS length. Match the draft's language (if it's in Spanish, reply in Spanish). ` +
      `Do not add a greeting or sign-off unless the draft already implies one.`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: text }],
    });

    const result = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();

    if (!result) {
      res.status(502).json({ error: "Tone polish returned empty result" });
      return;
    }

    res.json({
      result,
      tone,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });
  } catch (e: any) {
    if (e instanceof Anthropic.AuthenticationError) {
      console.error("[message-tone] Auth error:", e.message);
      res.status(503).json({ error: "AI tone auth failed — check ANTHROPIC_API_KEY" });
      return;
    }
    if (e instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: "AI tone temporarily rate-limited — try again in a moment" });
      return;
    }
    console.error("[message-tone] Error:", e);
    res.status(500).json({ error: "AI tone failed", message: e?.message });
  }
});

export default router;
