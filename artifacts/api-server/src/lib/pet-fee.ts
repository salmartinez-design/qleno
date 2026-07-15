// ── Pet fee ──────────────────────────────────────────────────────────────────
// Optional surcharge applied when a home has pets. Configured per-company on
// `offer_settings` (pet_fee_enabled / pet_fee_type / pet_fee_amount) and applied
// by the pricing engine. Ships DISABLED — no price change until a company turns
// it on. Kept as a PURE function so the math is unit-testable without the DB.

export type PetFeeType = "flat" | "percent";

export interface PetFeeConfig {
  enabled: boolean;
  type: PetFeeType;
  // For "flat": a dollar amount added once when the home has any pets.
  // For "percent": a percentage (0–100) of the base price.
  amount: number;
}

/**
 * Returns the pet fee to add to a quote, rounded to cents.
 * Returns 0 when disabled, when there are no pets, or when the amount is <= 0.
 * `basePrice` is only used for the "percent" type.
 */
export function computePetFee(
  config: PetFeeConfig | null | undefined,
  petCount: number,
  basePrice: number,
): number {
  if (!config || !config.enabled) return 0;
  if (!petCount || petCount <= 0) return 0;
  const amount = Number(config.amount);
  if (!isFinite(amount) || amount <= 0) return 0;

  const fee = config.type === "percent" ? (amount / 100) * basePrice : amount;
  return Math.round(fee * 100) / 100;
}

/** Normalizes a raw offer_settings row into a PetFeeConfig (defaults = disabled). */
export function petFeeConfigFromRow(row: any): PetFeeConfig {
  const type = String(row?.pet_fee_type ?? "flat").toLowerCase();
  return {
    enabled: row?.pet_fee_enabled === true || row?.pet_fee_enabled === "true",
    type: type === "percent" ? "percent" : "flat",
    amount: parseFloat(String(row?.pet_fee_amount ?? 0)) || 0,
  };
}
