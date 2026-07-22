// [engagement-tracking-phase4 2026-06-25] Native click-redirect + open-pixel
// endpoints (PUBLIC, no auth — the token IS the capability). Each hit records an
// engagement_event tied to the estimate + enrollment, then:
//   GET /api/track/c/:token        → 302 to the stored target_url (click)
//   GET /api/track/o/:token(.png)  → 1x1 transparent GIF (open)
// Unknown/again tokens still behave gracefully (redirect home / return pixel) so
// a stale link never errors a customer.

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { recordEngagementEvent } from "../lib/engagement.js";
import { appBaseUrl } from "../lib/app-url.js";

const router = Router();

// 1x1 transparent GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function sendPixel(res: any) {
  res.set({
    "Content-Type": "image/gif",
    "Content-Length": String(PIXEL.length),
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "Pragma": "no-cache",
    "Expires": "0",
  });
  return res.status(200).send(PIXEL);
}

// ── Click redirect ──────────────────────────────────────────────────────────
router.get("/c/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  let target = `${appBaseUrl()}/`;
  try {
    const rows = await db.execute(sql`
      SELECT company_id, estimate_id, enrollment_id, target_url, recipient
      FROM tracked_links WHERE token = ${token} AND kind = 'click' LIMIT 1
    `);
    const link = (rows as any).rows[0];
    if (link) {
      if (link.target_url) target = link.target_url;
      await recordEngagementEvent({
        companyId: link.company_id,
        estimateId: link.estimate_id,
        enrollmentId: link.enrollment_id,
        eventType: "clicked",
        channel: "email",
        recipient: link.recipient ?? null,
        meta: { token, target_url: link.target_url, ua: req.get("user-agent") || null },
      });
    }
  } catch (err) {
    console.error("[track] click error (non-fatal):", err);
  }
  return res.redirect(302, target);
});

// ── Open pixel ──────────────────────────────────────────────────────────────
// Accepts /o/:token and /o/:token.png (the .png is stripped).
router.get("/o/:token", async (req, res) => {
  const token = String(req.params.token || "").trim().replace(/\.png$/i, "");
  try {
    const rows = await db.execute(sql`
      SELECT company_id, estimate_id, enrollment_id, recipient
      FROM tracked_links WHERE token = ${token} AND kind = 'open' LIMIT 1
    `);
    const link = (rows as any).rows[0];
    if (link) {
      // [open-tracking-accuracy 2026-07-22] A raw pixel hit is NOT a human open.
      // Apple Mail Privacy Protection, Gmail's image proxy and mail scanners
      // prefetch the image — which logged 9 "Email opened" events for a single
      // recipient in minutes (Sal: "confirm the audit log is correct"). Two
      // guards so the log and the counts mean what the office thinks they mean:
      //   1. Skip known proxy/scanner user-agents outright.
      //   2. Collapse repeat opens from the same recipient on the same estimate
      //      inside a 30-minute window into the first one.
      // Genuine re-reads hours/days later still record.
      const ua = req.get("user-agent") || "";
      const isPrefetch = /GoogleImageProxy|YahooMailProxy|Barracuda|Proofpoint|Mimecast|MessageLabs|Symantec|bot\b|crawler|spider|scanner|preview/i.test(ua);
      let duplicate = false;
      if (!isPrefetch) {
        const dup = await db.execute(sql`
          SELECT 1 FROM engagement_events
           WHERE company_id = ${link.company_id}
             AND event_type = 'opened'
             AND estimate_id IS NOT DISTINCT FROM ${link.estimate_id ?? null}
             AND recipient IS NOT DISTINCT FROM ${link.recipient ?? null}
             AND occurred_at > now() - interval '30 minutes'
           LIMIT 1`);
        duplicate = ((dup as any).rows?.length ?? 0) > 0;
      }
      if (!isPrefetch && !duplicate) {
        await recordEngagementEvent({
          companyId: link.company_id,
          estimateId: link.estimate_id,
          enrollmentId: link.enrollment_id,
          eventType: "opened",
          channel: "email",
          recipient: link.recipient ?? null,
          meta: { token, ua: ua || null },
        });
      }
    }
  } catch (err) {
    console.error("[track] open error (non-fatal):", err);
  }
  return sendPixel(res);
});

export default router;
