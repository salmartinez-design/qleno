/**
 * Phase 1 — Lead pipeline + cadence schema guard, and estimate GHL-removal guard.
 *
 * Runs against the stub DATABASE_URL like the rest of the suite (no DB
 * connection). Two regressions are guarded:
 *
 *  1. The lead pipeline tables (leads, lead_activity_log) and the cadence
 *     engine tables (follow_up_*, message_log) used to exist ONLY as raw-SQL
 *     boot migrations with no Drizzle model. routes/leads.ts references columns
 *     by name in raw SQL — including `agreement_signed`, which was absent from
 *     prod and made every PATCH /api/leads/:id 500. These assertions pin the
 *     full set of referenced columns onto the now-typed schema so a fresh DB
 *     and prod converge, and they cross-check that the boot migration emits an
 *     additive `agreement_signed` column.
 *
 *  2. The estimate workflow is 100% native — the GoHighLevel outbound bridge
 *     was removed. These assertions confirm routes/estimates.ts no longer
 *     imports or calls GHL, yet still mints the public token on send.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  leadsTable,
  leadActivityLogTable,
  followUpSequencesTable,
  followUpStepsTable,
  followUpEnrollmentsTable,
  messageLogTable,
} from "@workspace/db/schema";

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(resolve(here, rel), "utf8");

function assertColumns(table: any, name: string, cols: string[]) {
  for (const c of cols) {
    const col = table[c];
    assert.ok(col, `${name}.${c} should exist on the Drizzle schema`);
    assert.equal(col.name, c, `${name}.${c} should map to DB column "${c}"`);
  }
}

// Every column routes/leads.ts, lib/lead-sync.ts and routes/public.ts read or
// write on the leads table (raw SQL). If a route references a new column, add
// it here AND to the schema/migration — that is the point of this guard.
const LEAD_COLUMNS = [
  "id", "company_id", "first_name", "last_name", "phone", "email",
  "sqft", "address", "city", "state", "zip", "scope", "bedrooms", "bathrooms",
  "message", "condition_flag", "construction_type", "completion_date",
  "lead_type", "notes", "status", "source", "assigned_to", "referral_partner_id",
  "quote_amount", "contacted_at", "contacted_by", "quoted_at", "booked_at",
  "closed_reason", "agreement_signed", "job_id", "created_at", "updated_at",
];

describe("Phase 1 — leads schema covers every column the routes reference", () => {
  it("leadsTable exposes all referenced columns", () => {
    assertColumns(leadsTable, "leads", LEAD_COLUMNS);
  });

  it("leads.agreement_signed exists (closes the PATCH /api/leads/:id 500)", () => {
    const col = (leadsTable as any).agreement_signed;
    assert.ok(col, "leads.agreement_signed must exist on the schema");
    assert.equal(col.name, "agreement_signed");
  });

  it("leads.status defaults to needs_contacted", () => {
    assert.equal((leadsTable as any).status.default, "needs_contacted");
  });

  it("lead_activity_log exposes its columns", () => {
    assertColumns(leadActivityLogTable, "lead_activity_log", [
      "id", "lead_id", "company_id", "action_type", "note", "performed_by", "created_at",
    ]);
  });
});

describe("Phase 1 — cadence tables are now typed Drizzle models", () => {
  it("follow_up_sequences columns", () => {
    assertColumns(followUpSequencesTable, "follow_up_sequences", [
      "id", "company_id", "sequence_type", "name", "is_active", "created_at",
    ]);
  });
  it("follow_up_steps columns (incl. template_id)", () => {
    assertColumns(followUpStepsTable, "follow_up_steps", [
      "id", "sequence_id", "step_number", "delay_hours", "channel",
      "subject", "message_template", "template_id", "created_at",
    ]);
  });
  it("follow_up_enrollments columns (incl. lead_id + abandoned_booking_id)", () => {
    assertColumns(followUpEnrollmentsTable, "follow_up_enrollments", [
      "id", "company_id", "sequence_id", "quote_id", "client_id", "lead_id",
      "abandoned_booking_id", "current_step", "enrolled_at", "next_fire_at",
      "completed_at", "stopped_at", "stopped_reason",
    ]);
  });
  it("message_log columns", () => {
    assertColumns(messageLogTable, "message_log", [
      "id", "company_id", "enrollment_id", "client_id", "channel",
      "recipient_phone", "recipient_email", "subject", "body", "status",
      "sequence_name", "step_number", "sent_at",
    ]);
  });
});

describe("Phase 1 — boot migration emits the additive lead columns", () => {
  const migration = readSrc("../phes-data-migration.ts");
  it("migration adds agreement_signed idempotently", () => {
    assert.match(
      migration,
      /ALTER TABLE leads ADD COLUMN IF NOT EXISTS agreement_signed BOOLEAN/,
      "phes-data-migration.ts must ADD COLUMN IF NOT EXISTS leads.agreement_signed",
    );
  });
});

describe("Phase 1 — estimate workflow is native (no GoHighLevel)", () => {
  const estimates = readSrc("../routes/estimates.ts");
  it("does not import or call GHL anymore", () => {
    assert.doesNotMatch(estimates, /lib\/ghl/, "must not import lib/ghl");
    assert.doesNotMatch(estimates, /fireGhlWebhook/, "must not call fireGhlWebhook");
    assert.doesNotMatch(estimates, /notifyGhl/, "must not call notifyGhl");
  });
  it("send still mints the public token + marks sent", () => {
    assert.match(estimates, /status = 'sent'/, "send must still mark status sent");
    assert.match(estimates, /public_token = \$\{token\}/, "send must still persist the public token");
  });
  it("accept + decline handlers are still present", () => {
    assert.match(estimates, /\/public\/:token\/accept/, "accept route present");
    assert.match(estimates, /\/public\/:token\/decline/, "decline route present");
  });
});
