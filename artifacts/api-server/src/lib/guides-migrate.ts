// [help-guides 2026-06-21] Idempotent boot migration for the in-app Help &
// Guides center. Creates the `guides` table via raw SQL (so the feature works on
// a fresh deploy WITHOUT a separate drizzle-kit push) and seeds one placeholder
// TECH guide so the surface renders end-to-end before the real captured
// screenshots + EN/ES captions land. Re-running is a no-op (guarded inserts).
// Safe to call on every cold start. Mirrors runAutoPromosMigration.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Placeholder TECH guide. The `image` paths point at committed assets under the
// frontend's public/guides/<slug>/ dir (served at /guides/...). Until the real
// screenshots are dropped in, these resolve to a small placeholder PNG so the
// viewer + PDF render without a broken image. Replace the steps (and images)
// with the real captured content — no code change needed beyond the seed/DB row.
const PLACEHOLDER_TECH_GUIDE = {
  slug: "getting-started-tech",
  audience: "tech",
  category: "Getting started",
  icon: "Smartphone",
  sort_order: 0,
  title_en: "Getting started on your phone",
  title_es: "Empezando en tu teléfono",
  summary_en: "A quick tour of your day: see your jobs, clock in, and finish up.",
  summary_es: "Un recorrido rápido de tu día: ve tus trabajos, registra entrada y termina.",
  steps: [
    {
      order: 1,
      image: "/guides/getting-started-tech/step-1.png",
      caption_en: "Open My Jobs to see every job assigned to you today, in order.",
      caption_es: "Abre Mis Trabajos para ver cada trabajo asignado para hoy, en orden.",
    },
    {
      order: 2,
      image: "/guides/getting-started-tech/step-2.png",
      caption_en: "Tap a job to see the address, customer notes, and what to clean.",
      caption_es: "Toca un trabajo para ver la dirección, las notas del cliente y qué limpiar.",
    },
    {
      order: 3,
      image: "/guides/getting-started-tech/step-3.png",
      caption_en: "Press Clock In when you arrive, and Clock Out when you finish.",
      caption_es: "Presiona Registrar entrada al llegar y Registrar salida al terminar.",
    },
  ],
};

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

    // Seed the placeholder tech guide once. Guarded on slug so a re-run (or a
    // hand-edited row) is never clobbered.
    const g = PLACEHOLDER_TECH_GUIDE;
    await db.execute(sql`
      INSERT INTO guides
        (slug, audience, category, icon, sort_order, published,
         title_en, title_es, summary_en, summary_es, steps)
      SELECT ${g.slug}, ${g.audience}, ${g.category}, ${g.icon}, ${g.sort_order}, true,
             ${g.title_en}, ${g.title_es}, ${g.summary_en}, ${g.summary_es},
             ${JSON.stringify(g.steps)}::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM guides WHERE slug = ${g.slug})
    `);
    console.log("[help-guides] migration ok — guides table ready + placeholder tech guide seeded");
  } catch (err) {
    console.error("[help-guides] migration error (non-fatal):", err);
  }
}
