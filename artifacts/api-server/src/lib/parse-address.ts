/**
 * Split a one-line US address into its parts.
 *
 * THE BUG THIS CLOSES (Maribel, 8/19): "it's not cascading from the quote, so
 * we can't see the city and for some reason doesnt assign the zone
 * automatically."
 *
 * The quote builder stores the address as a SINGLE text column — `quotes.address`
 * — because that is how the office types it. Convert then carried that string
 * forward whole:
 *
 *   - materializeClientForQuote wrote it to `clients.address` and left
 *     `city`, `state` and `zip` NULL
 *   - the job INSERT wrote it to `jobs.address_street` and set no city, no
 *     state, no zip, and no zone_id
 *
 * So a converted quote produced a customer with no city on file and a job with
 * no zone — the dispatch board could not colour it, routing could not place it,
 * and the card showed a street with no town. Cynthiia Lopezz (CL-1533) is the
 * shape exactly: `clients.address` reading "17878 Argos Court, Tinley Park, IL
 * 60477" with the three component columns empty.
 *
 * ── WHY PARSE RATHER THAN ADD COLUMNS TO QUOTES ──────────────────────────────
 *
 * The office types one line and should keep typing one line. The components are
 * derivable from it, and every consumer downstream — zone routing, the dispatch
 * tile, the address formatter, geocoding — wants them separately. Parsing at the
 * boundary means the one-line habit survives and the structured data exists.
 *
 * ── DELIBERATELY CONSERVATIVE ────────────────────────────────────────────────
 *
 * This never guesses. A string it cannot read confidently yields `{ street }`
 * and nulls, which is exactly today's behaviour — no worse, and nothing invented.
 * A wrong city is far more damaging than a missing one: it routes a cleaner to
 * the wrong town and prints a wrong address on the customer's confirmation.
 */

/** Two-letter USPS state codes. Used to anchor the tail of the string. */
const STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
  "WI","WY","DC","PR","VI","GU","AS","MP",
]);

export interface ParsedAddress {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

const EMPTY: ParsedAddress = { street: null, city: null, state: null, zip: null };
const tidy = (v: string | null | undefined) => {
  const s = String(v ?? "").trim().replace(/\s+/g, " ").replace(/^,|,$/g, "").trim();
  return s || null;
};

/**
 * Parse "123 Main St, Springfield, IL 62704" and its common shortenings.
 *
 * Recognised, in order of confidence:
 *   "street, city, ST zip"   → all four
 *   "street, city, ST"       → street, city, state
 *   "street, city zip"       → street, city, zip   (no state typed)
 *   "street, city"           → street, city
 *   "street"                 → street only
 *
 * A trailing country ("USA", "United States") is dropped. Anything that does not
 * fit returns the whole input as `street` with the rest null.
 */
export function parseAddressLine(input: string | null | undefined): ParsedAddress {
  const raw = tidy(input);
  if (!raw) return { ...EMPTY };

  let parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { ...EMPTY };

  // Drop a trailing country so it can't be mistaken for the city.
  const last = parts[parts.length - 1].toUpperCase().replace(/\./g, "");
  if (parts.length > 1 && (last === "USA" || last === "US" || last === "UNITED STATES")) {
    parts = parts.slice(0, -1);
  }
  if (parts.length === 1) return { street: tidy(parts[0]), city: null, state: null, zip: null };

  const tail = parts[parts.length - 1];
  // "IL 60477" / "IL" / "60477" / "IL 60477-1234"
  const stateZip = /^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(tail);
  const stateOnly = /^([A-Za-z]{2})$/.exec(tail);
  const zipOnly = /^(\d{5})(?:-\d{4})?$/.exec(tail);

  if (stateZip && STATE_CODES.has(stateZip[1].toUpperCase())) {
    return {
      street: tidy(parts.slice(0, -2).join(", ")) ?? tidy(parts[0]),
      city: parts.length >= 3 ? tidy(parts[parts.length - 2]) : null,
      state: stateZip[1].toUpperCase(),
      zip: stateZip[2],
    };
  }
  if (stateOnly && STATE_CODES.has(stateOnly[1].toUpperCase())) {
    return {
      street: tidy(parts.slice(0, -2).join(", ")) ?? tidy(parts[0]),
      city: parts.length >= 3 ? tidy(parts[parts.length - 2]) : null,
      state: stateOnly[1].toUpperCase(),
      zip: null,
    };
  }
  if (zipOnly) {
    return {
      street: tidy(parts.slice(0, -2).join(", ")) ?? tidy(parts[0]),
      city: parts.length >= 3 ? tidy(parts[parts.length - 2]) : null,
      state: null,
      zip: zipOnly[1],
    };
  }

  // "…, city 60477" — no state typed, zip stuck on the city.
  const cityZip = /^(.+?)\s+(\d{5})(?:-\d{4})?$/.exec(tail);
  if (cityZip) {
    return {
      street: tidy(parts.slice(0, -1).join(", ")),
      city: tidy(cityZip[1]),
      state: null,
      zip: cityZip[2],
    };
  }

  // "street, city" — the last segment is a plain word, treat it as the city.
  // Only when it has no digits: "Apt 4" is not a town.
  if (!/\d/.test(tail)) {
    return { street: tidy(parts.slice(0, -1).join(", ")), city: tidy(tail), state: null, zip: null };
  }

  // Unreadable — hand the whole thing back as the street rather than guess.
  return { street: raw, city: null, state: null, zip: null };
}

/**
 * Best-effort components for a record that may already have some.
 *
 * Anything already stored WINS — this only fills gaps. A record whose city was
 * typed by hand must never be overwritten by a parse of a stale one-line copy.
 */
export function fillAddressGaps(
  existing: Partial<ParsedAddress>,
  line: string | null | undefined,
): ParsedAddress {
  const p = parseAddressLine(line);
  return {
    street: tidy(existing.street) ?? p.street,
    city: tidy(existing.city) ?? p.city,
    state: tidy(existing.state) ?? p.state,
    zip: tidy(existing.zip) ?? p.zip,
  };
}
