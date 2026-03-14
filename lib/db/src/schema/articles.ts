import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const articlesTable = pgTable("articles", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title_en: text("title_en").notNull(),
  title_es: text("title_es"),
  content_en: text("content_en").notNull().default(""),
  content_es: text("content_es"),
  category: text("category"),
  published: boolean("published").notNull().default(false),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertArticleSchema = createInsertSchema(articlesTable).omit({ id: true, created_at: true, updated_at: true });
export type InsertArticle = z.infer<typeof insertArticleSchema>;
export type Article = typeof articlesTable.$inferSelect;
