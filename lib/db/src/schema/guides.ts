// [help-guides 2026-06-21] In-app Help & Guides center. Platform-level (global)
// how-to guides — step-by-step screenshots + bilingual EN/ES captions — that
// every tenant sees. Authored content (no per-tenant data), so `company_id` is
// nullable and v1 rows are always global (NULL). Audience scoping ('tech' |
// 'office' | 'all') drives who sees a guide; the read API filters by the
// caller's JWT role so techs can't enumerate office guides.
//
// Steps live in a JSONB array (one row = one whole guide → the viewer and the
// PDF generator each read a single record). Each step pairs ONE screenshot with
// a short EN + ES caption. `image` is an OPAQUE path/URL (v1: committed asset
// like "/guides/<slug>/step-1.png"); keeping it opaque lets screenshots move to
// object storage later without a content rewrite.
import { pgTable, serial, text, integer, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type GuideStep = {
  order: number;
  image: string;       // opaque path/URL, e.g. "/guides/clock-in-to-a-job/step-1.png"
  caption_en: string;
  caption_es: string;
};

export type GuideAudience = "tech" | "office" | "all";

export const guidesTable = pgTable("guides", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  audience: text("audience").notNull().default("all"),
  category: text("category"),
  icon: text("icon"),                                   // lucide icon name
  sort_order: integer("sort_order").notNull().default(0),
  published: boolean("published").notNull().default(true),
  company_id: integer("company_id"),                    // null = global/platform (v1 always null)
  title_en: text("title_en").notNull(),
  title_es: text("title_es"),
  summary_en: text("summary_en"),
  summary_es: text("summary_es"),
  steps: jsonb("steps").$type<GuideStep[]>().notNull().default([]),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertGuideSchema = createInsertSchema(guidesTable).omit({ id: true, created_at: true, updated_at: true });
export type InsertGuide = z.infer<typeof insertGuideSchema>;
export type Guide = typeof guidesTable.$inferSelect;
