import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

// [booking-confirmation GAP1] Public, no-login customer appointment view. The
// link the booking confirmation email/SMS carries. Resolves a job by its
// customer_view_token and returns a CUSTOMER-SAFE subset (no pricing, no
// internal notes, no tech contact info) plus the tenant's branding.
function labelService(raw: string | null): string {
  if (!raw) return "Cleaning service";
  return raw.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Friendly customer-facing status. The DB job_status enum is
// scheduled|in_progress|complete|cancelled; map to plain language.
function friendlyStatus(raw: string | null): string {
  switch (raw) {
    case "in_progress": return "in_progress";
    case "complete": return "complete";
    case "cancelled": return "cancelled";
    default: return "scheduled";
  }
}

router.get("/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(404).json({ error: "Not Found" });

    const rows = await db.execute(sql`
      SELECT j.id, j.scheduled_date, j.scheduled_time, j.arrival_window, j.service_type, j.status,
             j.address_street, j.address_city, j.address_state, j.address_zip,
             c.first_name AS client_first,
             u.first_name AS tech_first, u.avatar_url AS tech_avatar,
             co.name AS company_name, co.logo_url AS company_logo,
             co.brand_color AS company_brand_color, co.phone AS company_phone, co.email AS company_email
      FROM jobs j
      JOIN companies co ON co.id = j.company_id
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN users u ON u.id = j.assigned_user_id
      WHERE j.customer_view_token = ${token}
      LIMIT 1
    `);
    const j: any = rows.rows[0];
    if (!j) return res.status(404).json({ error: "Not Found" });

    const stateZip = [j.address_state, j.address_zip].filter(Boolean).join(" ");
    const serviceAddress = [j.address_street, j.address_city, stateZip].filter(Boolean).join(", ") || null;

    return res.json({
      client_first: j.client_first || null,
      status: friendlyStatus(j.status),
      scheduled_date: j.scheduled_date || null,
      scheduled_time: j.scheduled_time || null,
      arrival_window: j.arrival_window || null,
      service_type: labelService(j.service_type),
      service_address: serviceAddress,
      // Cleaner-as-a-person: first name + existing profile photo ONLY. No last
      // name, phone, or email is ever exposed for the tech.
      tech_first: j.tech_first || null,
      tech_avatar: j.tech_avatar || null,
      company_name: j.company_name,
      company_logo: j.company_logo,
      company_brand_color: j.company_brand_color,
      company_phone: j.company_phone,
      company_email: j.company_email,
    });
  } catch (err) {
    console.error("Public appointment error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [apple-calendar] Hosted .ics for the confirmation email's "Add to calendar"
// Apple button. Email clients (Gmail, Apple Mail) block data: URIs, so Apple
// needs a real https link that returns text/calendar — Google/Outlook use their
// own web deeplinks. Same 2-hour default window as those links.
router.get("/:token/calendar.ics", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(404).send("Not Found");
    // [test-ics 2026-07-19] Send Test booking-confirmation emails have no real
    // job/token, so the test render points the Apple "Add to Calendar" button at
    // token 'sample'. Return a static sample event so the button is actually
    // testable (a data: URI gets stripped by Gmail/Apple Mail). Matches the sample
    // date the [TEST] email shows.
    if (token === "sample") {
      const sampleIcs = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Phes//Booking//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        "BEGIN:VEVENT", "UID:sample@qleno", "DTSTAMP:20260627T090000", "DTSTART:20260627T090000", "DTEND:20260627T110000",
        "SUMMARY:Phes cleaning (sample)",
        "LOCATION:123 Sample St, Chicago, IL 60601",
        "DESCRIPTION:Sample booking confirmation calendar event.",
        "END:VEVENT", "END:VCALENDAR",
      ].join("\r\n");
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="appointment-sample.ics"');
      return res.send(sampleIcs);
    }
    const rows = await db.execute(sql`
      SELECT j.scheduled_date, j.scheduled_time, j.arrival_window, j.service_type,
             j.address_street, j.address_city, j.address_state, j.address_zip,
             co.name AS company_name
      FROM jobs j JOIN companies co ON co.id = j.company_id
      WHERE j.customer_view_token = ${token} LIMIT 1`);
    const j: any = rows.rows[0];
    if (!j) return res.status(404).send("Not Found");

    const iso = j.scheduled_date instanceof Date
      ? j.scheduled_date.toISOString().slice(0, 10)
      : String(j.scheduled_date || "").slice(0, 10);
    const [y, mo, d] = iso.split("-").map(Number);
    if (!y || !mo || !d) return res.status(404).send("Not Found");
    const mm = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i.exec(String(j.scheduled_time || j.arrival_window || "9:00 AM").trim());
    let h = 9, min = 0;
    if (mm) { h = parseInt(mm[1], 10); min = parseInt(mm[2], 10); const ap = mm[3]?.toUpperCase(); if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0; }
    const pad = (n: number) => String(n).padStart(2, "0");
    const start = new Date(Date.UTC(y, mo - 1, d, h, min, 0));
    const end = new Date(start.getTime() + 2 * 3600 * 1000);
    const fmt = (dt: Date) => `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00`;
    const escIcs = (s: string) => String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
    const company = j.company_name || "Phes";
    const stateZip = [j.address_state, j.address_zip].filter(Boolean).join(" ");
    const loc = [j.address_street, j.address_city, stateZip].filter(Boolean).join(", ");
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Phes//Booking//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT", `UID:${token}@qleno`, `DTSTAMP:${fmt(start)}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
      `SUMMARY:${escIcs(`${company} cleaning`)}`,
      `LOCATION:${escIcs(loc)}`,
      `DESCRIPTION:${escIcs(`Your ${labelService(j.service_type)} with ${company}.`)}`,
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="appointment.ics"');
    return res.send(ics);
  } catch (err) {
    console.error("Appointment .ics error:", err);
    return res.status(500).send("Internal Server Error");
  }
});

export default router;
