// [sat-cutoff 2026-08-19] Saturday is a short crew day at Phes. The office
// needs to keep Saturday bookable while capping how late a Saturday job may
// start (10:00 AM). Before this, booking_settings could only turn a whole day
// on or off, and the widget offered the identical 9:00 AM–2:00 PM list every
// day, so the only way to stop a 2:00 PM Saturday was to close Saturday.
//
// Two failure modes this locks down:
//
//   1. The weekday read. A date arrives as "YYYY-MM-DD". Building a Date from
//      that bare string parses as UTC midnight, which is the previous evening
//      in America/Chicago — getDay() then reports Friday for a Saturday and
//      the customer is handed the full afternoon. slotsForDate parses at local
//      NOON so the weekday is right on both sides of the boundary.
//
//   2. Leaking the cap onto other days. The cutoff is Saturday-only. A bug
//      that applies it to every weekday quietly deletes half the company's
//      bookable inventory, and nothing errors — the widget just shows fewer
//      times.
//
// The settings-page and widget wiring is checked as source text because those
// files can't be imported outside a React/Vite graph.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOOKING_TIME_SLOTS, slotsForDate } from "../../../qleno/src/lib/booking-slots.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const TEN_AM = 600;
// 2026-08-22 is a Saturday; 2026-08-21 the Friday before it.
const SAT = "2026-08-22";
const FRI = "2026-08-21";

describe("booking-slots: Saturday start-time cutoff", () => {
  it("offers 9:00 AM through 2:00 PM in 30-minute steps", () => {
    assert.equal(BOOKING_TIME_SLOTS[0].label, "9:00 AM");
    assert.equal(BOOKING_TIME_SLOTS.at(-1)!.label, "2:00 PM");
    assert.equal(BOOKING_TIME_SLOTS.length, 11);
    assert.ok(BOOKING_TIME_SLOTS.every((s, i) => i === 0 || s.minutes - BOOKING_TIME_SLOTS[i - 1].minutes === 30));
  });

  it("caps Saturday at the cutoff and keeps the cutoff slot itself bookable", () => {
    const slots = slotsForDate(SAT, TEN_AM);
    assert.deepEqual(slots.map(s => s.label), ["9:00 AM", "9:30 AM", "10:00 AM"]);
  });

  it("leaves every other weekday at the full list", () => {
    assert.equal(slotsForDate(FRI, TEN_AM).length, BOOKING_TIME_SLOTS.length);
    for (const d of ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-23"]) {
      assert.equal(slotsForDate(d, TEN_AM).length, BOOKING_TIME_SLOTS.length, `${d} should be uncapped`);
    }
  });

  it("treats a null or missing cutoff as no Saturday limit", () => {
    assert.equal(slotsForDate(SAT, null).length, BOOKING_TIME_SLOTS.length);
    assert.equal(slotsForDate(SAT, undefined).length, BOOKING_TIME_SLOTS.length);
  });

  it("returns the full list when no date is selected yet", () => {
    assert.equal(slotsForDate("", TEN_AM).length, BOOKING_TIME_SLOTS.length);
  });

  it("reads the weekday at local noon, not the UTC-midnight boundary", () => {
    // The regression: `new Date("2026-08-22")` is UTC midnight, which is
    // Friday 7:00 PM in America/Chicago, so getDay() returns 5 and the cap
    // never fires. Assert we do NOT parse it that way.
    assert.match(read("../../../qleno/src/lib/booking-slots.ts"), /T12:00:00/);
    assert.ok(slotsForDate(SAT, TEN_AM).length < BOOKING_TIME_SLOTS.length,
      "Saturday must be capped regardless of the host machine's timezone");
  });
});

describe("booking widget + settings page route through the shared list", () => {
  const book = read("../../../qleno/src/pages/book.tsx");
  const company = read("../../../qleno/src/pages/company.tsx");

  it("book.tsx builds BOTH time pickers from slotsForDate, never the raw list", () => {
    assert.ok(book.includes('from "@/lib/booking-slots"'), "book.tsx must import the shared list");
    assert.ok(book.includes("slotsForDate(selectedDate, bookingSettings?.sat_last_start_minutes)"),
      "one-time picker must filter by date");
    assert.ok(book.includes("slotsForDate(recurringDate, bookingSettings?.sat_last_start_minutes)"),
      "recurring picker must filter by date");
    assert.ok(!/TIME_SLOTS\.map/.test(book),
      "a raw TIME_SLOTS.map would render capped times on a Saturday");
  });

  it("book.tsx clears a now-invalid selection when the date moves onto a Saturday", () => {
    // Pick 1:00 PM on a Thursday, then change the date to Saturday: without
    // this the option disappears from the list but the 1:00 PM value stays in
    // state and gets submitted as the arrival window.
    assert.ok(/setArrivalWindow\(""\)/.test(book), "stale one-time selection must be dropped");
    assert.ok(/setRecurringArrivalWindow\(""\)/.test(book), "stale recurring selection must be dropped");
  });

  it("the settings page offers the cutoff from the same slot list the widget renders", () => {
    assert.ok(company.includes("from '@/lib/booking-slots'"), "settings page must import the shared list");
    assert.ok(company.includes("BOOKING_TIME_SLOTS.map"), "cutoff options come from the shared list");
    assert.ok(company.includes("sat_last_start_minutes: satLastStart"), "the save body must carry the cutoff");
  });
});

describe("PUT /booking-settings merges instead of overwriting", () => {
  const companies = read("../routes/companies.ts");

  it("reads the existing row before writing", () => {
    // This handler used to write EVERY column from the body with hardcoded
    // defaults, so a caller that sent a partial body silently reset settings
    // it never mentioned — that is exactly how Saturday got switched off and
    // the lead time jumped back to 7 days.
    assert.match(companies, /SELECT \* FROM booking_settings WHERE company_id/);
    assert.match(companies, /const prev = \(cur\.rows\[0\] \?\? \{\}\)/);
  });

  it("falls back to the previous value, not a constant, for each field", () => {
    // Both helpers resolve body-first, stored-row-second, and only reach the
    // hardcoded default when the column has never been set at all.
    const reads = companies.match(/const v = b\[key\] !== undefined \? b\[key\] : prev\[key\];/g) ?? [];
    assert.equal(reads.length, 2, "both the number and boolean readers must fall back to prev");
    assert.match(companies, /b\.sat_last_start_minutes !== undefined[\s\S]{0,80}prev\.sat_last_start_minutes/);
  });

  it("is office-gated like the rest of the settings writes", () => {
    assert.match(companies,
      /router\.put\("\/booking-settings", requireAuth, requireRole\("owner", "admin", "office"\)/);
  });
});
