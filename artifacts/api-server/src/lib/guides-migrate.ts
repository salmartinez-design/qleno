// [help-guides 2026-06-21] Idempotent boot migration for the in-app Help &
// Guides center. Creates the `guides` table via raw SQL (so the feature works on
// a fresh deploy WITHOUT a separate drizzle-kit push) and upserts the authored
// tech guide set from guides-content.ts. Safe to call on every cold start.
// Mirrors runAutoPromosMigration.
//
// [help-guides 2026-06-25] Replaced the single placeholder seed with the full
// field-tech guide set. Upsert is ON CONFLICT (slug) DO UPDATE — per the repo
// seed rule and because the repo (guides-content.ts) is the source of truth in
// the Option-A model: editing wording there and redeploying refreshes the live
// guides. Screenshots are committed at each step's `image` path; the capture
// session overwrites those files with no content change.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { TECH_GUIDES, OFFICE_GUIDES } from "./guides-content.js";

export async function runGuidesMigration(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS guides (
        id serial PRIMARY KEY,
        slug text NOT NULL UNIQUE,
        audience text NOT NULL DEFAULT 'all',
        category text,
        icon text,
        sort_order integer NOT NULL DEFAULT 0,
        published boolean NOT NULL DEFAULT true,
        company_id integer,
        title_en text NOT NULL,
        title_es text,
        summary_en text,
        summary_es text,
        steps jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    // Helps the list endpoint's audience + ordering query.
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS guides_audience_sort_idx
        ON guides (audience, sort_order)
    `);

    // Upsert each authored guide. ON CONFLICT (slug) DO UPDATE so redeploying
    // after a wording edit refreshes the live row. `updated_at` is bumped only
    // on a real change.
    // Tech guides (audience 'tech') + office guides (audience 'office'). The
    // list/read endpoints wall techs to tech+all, so office guides never reach
    // a technician/team_lead — including by direct URL.
    for (const g of [...TECH_GUIDES, ...OFFICE_GUIDES]) {
      await db.execute(sql`
        INSERT INTO guides
          (slug, audience, category, icon, sort_order, published,
           title_en, title_es, summary_en, summary_es, steps, updated_at)
        VALUES
          (${g.slug}, ${g.audience}, ${g.category}, ${g.icon}, ${g.sort_order}, true,
           ${g.title_en}, ${g.title_es}, ${g.summary_en}, ${g.summary_es},
           ${JSON.stringify(g.steps)}::jsonb, now())
        ON CONFLICT (slug) DO UPDATE SET
          audience   = EXCLUDED.audience,
          category   = EXCLUDED.category,
          icon       = EXCLUDED.icon,
          sort_order = EXCLUDED.sort_order,
          published  = EXCLUDED.published,
          title_en   = EXCLUDED.title_en,
          title_es   = EXCLUDED.title_es,
          summary_en = EXCLUDED.summary_en,
          summary_es = EXCLUDED.summary_es,
          steps      = EXCLUDED.steps,
          updated_at = now()
      `);
    }
    console.log(`[help-guides] migration ok — guides table ready + ${TECH_GUIDES.length} tech + ${OFFICE_GUIDES.length} office guides upserted`);
  } catch (err) {
    console.error("[help-guides] migration error (non-fatal):", err);
  }
}
