import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeWeekOvertime,
  computeOvertimePremium,
  resolveOvertimeRules,
  normalizeStateCode,
  getPresetForState,
  FEDERAL_DEFAULT_RULES,
  STATE_OVERTIME_PRESETS,
} from "../lib/overtime.js";

test("federal/IL: weekly-40 only, no daily overtime", () => {
  // 5 days × 9h = 45h
  const r = computeWeekOvertime([0, 9, 9, 9, 9, 9, 0], FEDERAL_DEFAULT_RULES);
  assert.equal(r.totalHours, 45);
  assert.equal(r.otHours, 5);
  assert.equal(r.dtHours, 0);
  assert.equal(r.regularHours, 40);
});

test("federal: under 40 → no overtime", () => {
  const r = computeWeekOvertime([8, 8, 8, 8, 0, 0, 0], FEDERAL_DEFAULT_RULES);
  assert.equal(r.otHours, 0);
  assert.equal(r.dtHours, 0);
});

test("federal: a single 13h day is NOT overtime until the week passes 40", () => {
  const r = computeWeekOvertime([13, 0, 0, 0, 0, 0, 0], FEDERAL_DEFAULT_RULES);
  assert.equal(r.otHours, 0, "no daily OT federally");
  assert.equal(r.dtHours, 0);
});

test("California: daily OT after 8h", () => {
  const r = computeWeekOvertime([10, 0, 0, 0, 0, 0, 0], STATE_OVERTIME_PRESETS.CA);
  assert.equal(r.otHours, 2); // hours 9-10
  assert.equal(r.dtHours, 0);
});

test("California: double-time after 12h", () => {
  const r = computeWeekOvertime([13, 0, 0, 0, 0, 0, 0], STATE_OVERTIME_PRESETS.CA);
  assert.equal(r.otHours, 4); // hours 9-12
  assert.equal(r.dtHours, 1); // hour 13
});

test("California: no pyramiding — daily OT hours aren't re-counted weekly", () => {
  // 5 days × 10h = 50h. Each day: 8 straight + 2 OT → 40 straight, 10 daily OT.
  // Straight (40) does not exceed weekly 40 → no extra weekly OT.
  const r = computeWeekOvertime([0, 10, 10, 10, 10, 10, 0], STATE_OVERTIME_PRESETS.CA);
  assert.equal(r.totalHours, 50);
  assert.equal(r.otHours, 10);
  assert.equal(r.dtHours, 0);
});

test("premium is only the extra over straight time (commission already paid)", () => {
  // $900 commission / 45h = $20/hr regular rate. 5 OT hours × 0.5 × $20 = $50.
  const premium = computeOvertimePremium({
    otHours: 5, dtHours: 0, regularRate: 20, rules: FEDERAL_DEFAULT_RULES,
  });
  assert.equal(premium, 50);
});

test("premium: double-time hours owe a full extra rate", () => {
  // 2 DT hours × (2-1) × $20 = $40; 4 OT hours × 0.5 × $20 = $40 → $80.
  const premium = computeOvertimePremium({
    otHours: 4, dtHours: 2, regularRate: 20, rules: STATE_OVERTIME_PRESETS.CA,
  });
  assert.equal(premium, 80);
});

test("zero regular rate (no commission recorded) → zero premium, never negative", () => {
  assert.equal(computeOvertimePremium({ otHours: 5, dtHours: 0, regularRate: 0, rules: FEDERAL_DEFAULT_RULES }), 0);
});

test("normalizeStateCode handles codes and names", () => {
  assert.equal(normalizeStateCode("IL"), "IL");
  assert.equal(normalizeStateCode("il"), "IL");
  assert.equal(normalizeStateCode("Illinois"), "IL");
  assert.equal(normalizeStateCode("California"), "CA");
  assert.equal(normalizeStateCode("  ca "), "CA");
  assert.equal(normalizeStateCode(null), null);
  assert.equal(normalizeStateCode("Narnia"), null);
});

test("getPresetForState: IL → federal baseline, CA → daily rules", () => {
  const il = getPresetForState("Illinois");
  assert.equal(il.dailyThresholdHours, null);
  assert.equal(il.weeklyThresholdHours, 40);
  const ca = getPresetForState("CA");
  assert.equal(ca.dailyThresholdHours, 8);
  assert.equal(ca.seventhConsecutiveDayRule, true);
});

test("resolveOvertimeRules: unconfigured tenant falls back to state preset", () => {
  const il = resolveOvertimeRules({ state: "IL", ot_rules_source: null });
  assert.equal(il.rules.dailyThresholdHours, null);
  assert.match(il.source, /preset/);

  const ca = resolveOvertimeRules({ state: "California", ot_rules_source: null });
  assert.equal(ca.rules.dailyThresholdHours, 8);
});

test("resolveOvertimeRules: custom config wins over the state preset", () => {
  const custom = resolveOvertimeRules({
    state: "IL",
    ot_rules_source: "custom",
    ot_weekly_threshold_hours: "40.00",
    ot_daily_threshold_hours: "10.00",
    ot_daily_doubletime_hours: null,
    ot_seventh_day_rule: false,
    ot_multiplier: "1.50",
    ot_doubletime_multiplier: "2.00",
  });
  assert.equal(custom.source, "custom");
  assert.equal(custom.rules.dailyThresholdHours, 10);
});
