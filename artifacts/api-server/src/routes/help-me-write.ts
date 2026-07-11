import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "../lib/auth.js";

// [help-me-write 2026-07-11] Gmail-style "Help me write" for outbound customer
// SMS. Instead of rewriting an existing draft (that's /api/message-tone), this
// GENERATES a ready-to-send message from a short instruction the office types
// (e.g. "let the client know we're running 15 minutes late"). Same Claude setup
// as routes/message-tone.ts + translate.ts (ANTHROPIC_API_KEY, claude-haiku-4-5
// — cheap + fast for short SMS). It only reads the prompt (and an optional
// current draft as context); no tenant data is read, so there's nothing
// role-sensitive to gate beyond requireAuth.
//
// Requires ANTHROPIC_API_KEY in Railway env. If missing we surface a clear
// 503 so the operator knows to set it (mirrors translate.ts / message-tone.ts).

const router = Router();

const MAX_PROMPT_CHARS = 1000; // The instruction is short; keep the model cheap.
const MAX_CONTEXT_CHARS = 2000; // Existing draft passed as light context.
const MAX_CONVERSATION_CHARS = 6000; // Recent thread transcript (trimmed FE-side).

router.post("/", requireAuth, async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    // Optional: whatever is already in the composer, used only as context so a
    // half-written draft can be finished rather than discarded. Never required.
    const context = typeof req.body?.context === "string" ? req.body.context : "";
    // Optional: a transcript of the recent conversation with this customer
    // (most recent last, each line "Customer:" or "Us:") so the model can write
    // a reply that actually fits what was just said. Never required.
    const conversation = typeof req.body?.conversation === "string" ? req.body.conversation : "";

    if (!prompt.trim()) { res.status(400).json({ error: "prompt required" }); return; }
    if (prompt.length > MAX_PROMPT_CHARS) {
      res.status(400).json({ error: `prompt exceeds ${MAX_PROMPT_CHARS} chars` });
      return;
    }
    if (context.length > MAX_CONTEXT_CHARS) {
      res.status(400).json({ error: `context exceeds ${MAX_CONTEXT_CHARS} chars` });
      return;
    }
    // Over-long transcripts are trimmed (keep the most recent tail) rather than
    // rejected — the office shouldn't hit an error for a long thread.
    const convo = conversation.length > MAX_CONVERSATION_CHARS
      ? conversation.slice(-MAX_CONVERSATION_CHARS)
      : conversation;

    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("[help-me-write] ANTHROPIC_API_KEY not set — Help me write disabled");
      res.status(503).json({ error: "Help me write is not configured — set ANTHROPIC_API_KEY in Railway" });
      return;
    }

    const client = new Anthropic();

    // System prompt pins the model to WRITING one send-ready SMS from the
    // office's instruction — never answering the instruction as a question,
    // and never inventing hard facts (prices, dates, times, addresses) the
    // office didn't supply. Where a specific is genuinely needed but missing,
    // leave a short [bracketed] placeholder so the office fills it in before
    // sending — that's far safer than a hallucinated number.
    const system =
      `You write outbound text messages for a residential cleaning company sending SMS to its clients. ` +
      `You will be given a short instruction describing what the office wants to say, and often the recent conversation with the customer. ` +
      `Write ONE ready-to-send message that carries out the instruction. ` +
      `When a conversation is provided, USE IT: reply directly to what the customer last said, reference the relevant details, and keep the thread coherent (don't repeat what was already covered). ` +
      `Tone: warm, polished, and professional — the way a trusted local cleaning company texts a client. ` +
      `Keep it SMS-length and easy to read on a phone. ` +
      `Rules: Output ONLY the message text — no quotes, no options, no commentary, no preamble, no subject line. ` +
      `Do NOT invent specific facts (prices, dates, times, names, addresses) that the instruction or conversation doesn't give you; ` +
      `if a specific detail is truly required but missing, use a short bracketed placeholder like [time] or [date] for the office to fill in. ` +
      `Match the customer's language (if the conversation or instruction is in Spanish, write the message in Spanish). ` +
      `Include a brief, natural greeting and sign-off only if the message reads better with them.`;

    // Assemble the user turn: the recent conversation (if any) for grounding,
    // then the office's instruction, then any half-written draft to build on.
    let userContent = "";
    if (convo.trim()) {
      userContent += `Recent conversation with the customer (most recent last; "Customer:" is them, "Us:" is our team):\n${convo.trim()}\n\n`;
    }
    userContent += `Instruction: ${prompt}`;
    if (context.trim()) {
      userContent += `\n\nThe office has already started this draft — improve or continue it to match the instruction:\n${context}`;
    }

    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userContent }],
    });

    const result = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();

    if (!result) {
      res.status(502).json({ error: "Help me write returned empty result" });
      return;
    }

    res.json({
      result,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });
  } catch (e: any) {
    if (e instanceof Anthropic.AuthenticationError) {
      console.error("[help-me-write] Auth error:", e.message);
      res.status(503).json({ error: "Help me write auth failed — check ANTHROPIC_API_KEY" });
      return;
    }
    if (e instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: "Help me write temporarily rate-limited — try again in a moment" });
      return;
    }
    console.error("[help-me-write] Error:", e);
    res.status(500).json({ error: "Help me write failed", message: e?.message });
  }
});

export default router;
