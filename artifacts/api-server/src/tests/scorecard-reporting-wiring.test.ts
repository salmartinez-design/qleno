// [scorecard-dead-table 2026-08-08] `scorecards` is a LEGACY table. Nothing has
// written to it since the survey pipeline moved to `scorecard_entries`
// (captureJobScore writes one row per tech per job). Three surfaces still read
// the old one, so they showed nothing while the Scorecard report — reading the
// right table — showed 87% satisfaction off 24 real responses:
//
//   /reports/week-review  → "Quality Score 0.00/4" every week, flat quality trend
//   /reports/scorecards   → 0 records
//   /reports/insights     → "0 concern flags / all employees are performing well",
//                           even with Juan Salazar at 63% satisfaction (2.5 of 4)
//
// Verified live 2026-08-08: /api/reports/scorecards returned total 0 while
// /api/satisfaction/scorecard-results returned 97 sent / 28 returned.
//
// Also pinned: the customer's ANSWER now lands in the client's communication log.
// It only ever carried the outbound ask, so the office could see feedback was
// requested but never what came back. Maribel: "we have to make sure ALL
// communications with the clients is logged in the chat."
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const reports = read("../routes/reports.ts");
const engine = read("../lib/scorecard-engine.ts");

// Strip comments — the bug is documented in prose that names the old table.
// Strips JS block/line comments AND SQL `--` comments. The SQL ones matter: the
// swap is documented inside the queries themselves, and those comments mention
// both table names — without stripping them the sweep counts prose as a query.
const code = reports
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1")
  .replace(/--.*$/gm, "");

describe("no report reads the legacy table at all", () => {
  // [scorecard-dead-table 2026-08-08] The first pass asserted only week-review
  // and insights, so /reports/scorecards stayed broken and the suite still went
  // green — it returned 0 records in production after the "fix" deployed. A
  // whole-file sweep is the only assertion that can't be out-scoped like that.
  it("reports.ts contains no query against `scorecards`", () => {
    // FROM/JOIN only — `router.get("/scorecards")` is a URL, not a table.
    const hits = code.match(/\b(?:FROM|JOIN)\s+scorecards\b/gi) ?? [];
    assert.deepEqual(
      hits, [],
      "every read must target scorecard_entries — a per-endpoint assertion missed one last time",
    );
  });

  it("the legacy drizzle table object is no longer imported", () => {
    assert.ok(!/\bscorecardsTable\b/.test(code));
  });
});

describe("reporting reads the live scorecard table", () => {
  it("week-review quality no longer averages the legacy table", () => {
    const wr = code.slice(code.indexOf('router.get("/week-review"'));
    const block = wr.slice(0, wr.indexOf("router.get", 10) > 0 ? wr.indexOf("router.get", 10) : wr.length);
    assert.ok(!/FROM scorecards\b/.test(block), "week-review must not read the legacy `scorecards` table");
    assert.ok(block.includes("scorecard_entries"));
  });

  it("insights concern flags come from real ratings", () => {
    const ins = code.slice(code.indexOf('router.get("/insights"'), code.indexOf('router.get("/week-review"'));
    assert.ok(!/scorecardsTable/.test(ins), "insights must not query the legacy table object");
    assert.ok(ins.includes("scorecard_entries"));
    assert.ok(ins.includes("< 3.0"), "the flag threshold itself is unchanged");
  });

  it("scores are normalised back onto the 0-4 scale", () => {
    // scorecard_entries stores score_value against max_value; the old table stored
    // a bare 0-4 score. Dividing without re-scaling would render 0.94/4, not 3.75/4.
    const uses = code.match(/score_value \/ NULLIF\(max_value, 0\) \* 4/g) ?? [];
    assert.ok(uses.length >= 3, `expected the 0-4 rescale in every swapped query, saw ${uses.length}`);
  });

  it("every read honours the dismissed_at guard", () => {
    // The entries table has an office-dismissal flag the legacy table never had.
    // A dismissed complaint must never drag a report down.
    const swapped = code.split("scorecard_entries").slice(1);
    assert.ok(swapped.length >= 6, `expected every swapped query, saw ${swapped.length}`);
    for (const seg of swapped) {
      assert.match(seg.slice(0, 500), /dismissed_at IS NULL/);
    }
  });

  it("every AVERAGE also excludes excluded rows", () => {
    // The detail LIST deliberately keeps excluded rows (it renders the flag);
    // an AVERAGE must not include them.
    for (const m of code.matchAll(/avg\(\s*(?:se|sc)\.score_value[\s\S]{0,400}?\)/gi)) {
      const around = code.slice(m.index ?? 0, (m.index ?? 0) + 700);
      assert.ok(/excluded\s*=\s*false/.test(around), `average without an excluded filter: ${m[0].slice(0, 60)}`);
    }
  });
});

describe("customer feedback reaches the communication log", () => {
  it("captureJobScore writes an inbound log entry", () => {
    assert.ok(engine.includes("INSERT INTO communication_log"));
    assert.ok(engine.includes("'inbound'"), "it is a message FROM the customer");
  });

  it("the score and any comment are in the summary", () => {
    assert.ok(engine.includes("Customer rated this visit"));
    assert.match(engine, /notes && String\(notes\)\.trim\(\)/);
  });

  it("a log failure never loses the rating", () => {
    // The rating is already written and recomputed before this runs.
    const tail = engine.slice(engine.indexOf("INSERT INTO communication_log"));
    assert.match(tail, /catch \(e: any\)/);
    const head = engine.slice(0, engine.indexOf("INSERT INTO communication_log"));
    assert.ok(
      head.lastIndexOf("try {") > head.lastIndexOf("recomputeEmployeeScorecard(companyId, uid)"),
      "the log write must sit inside its own try AFTER the score is recomputed",
    );
  });
});
