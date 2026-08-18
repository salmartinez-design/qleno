/**
 * [address-sync 2026-08-18] Correcting a client's address on the PROFILE must
 * move that client's upcoming job cards with it.
 *
 * Francisco, 8/17 and again 8/18 ("yeap, not fixed yet lol"): the profile shows
 * the corrected address, the job card shows the old one, and the job card is
 * what the automated texts read. PATCH /jobs/:id/address cascaded; PUT
 * /clients/:id — the drawer the office actually uses — did not.
 *
 * The rules that must not drift:
 *   - MIRRORS move, one-off sites stay. A snapshot equal to the address the
 *     client had a moment ago is a copy with no information in it; a snapshot
 *     that differs is a deliberate service site.
 *   - All FOUR components decide that, city and state included. Street+zip
 *     alone is the Jess Wilhite bug (CL-1520, 8/8) and it has now been written
 *     three times in three places.
 *   - UPCOMING work only. A finished visit records where the service actually
 *     happened.
 *   - No previous address = nothing is a mirror = touch nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addressChanged } from "../lib/client-address-cascade.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const cascade = read("../lib/client-address-cascade.ts");
const clients = read("../routes/clients.ts");

describe("addressChanged", () => {
  const base = { address: "333 N Jefferson St", city: "Chicago", state: "IL", zip: "60661" };

  it("is false when nothing moved", () => {
    assert.equal(addressChanged(base, { ...base }), false);
  });

  it("ignores case and surrounding whitespace", () => {
    assert.equal(addressChanged(base, { ...base, city: "  chicago " }), false);
  });

  it("catches a city-only correction", () => {
    // The exact Jess Wilhite shape: same street, same zip, wrong city/state.
    assert.equal(addressChanged(base, { ...base, city: "Brownsburg", state: "IN" }), true);
  });

  it("catches a state-only correction", () => {
    assert.equal(addressChanged(base, { ...base, state: "IN" }), true);
  });

  it("catches a zip-only correction", () => {
    assert.equal(addressChanged(base, { ...base, zip: "60642" }), true);
  });

  it("treats null and empty string as the same absence", () => {
    assert.equal(addressChanged({ ...base, city: null }, { ...base, city: "" }), false);
  });
});

describe("the cascade only moves mirrored snapshots on upcoming work", () => {
  it("compares all four components, not street + zip", () => {
    const mirror = cascade.slice(cascade.indexOf("const mirrorsOld"), cascade.indexOf("const upcoming"));
    for (const part of ["address_street", "address_city", "address_state", "address_zip"]) {
      assert.ok(mirror.includes(part), `mirror test must compare ${part} — city/state are the pair that keeps getting dropped`);
    }
  });

  it("is scoped to future, still-live jobs", () => {
    const upcoming = cascade.slice(cascade.indexOf("const upcoming"), cascade.indexOf("// Count the one-off"));
    assert.ok(upcoming.includes("scheduled_date >= CURRENT_DATE"), "must not rewrite the past");
    assert.ok(upcoming.includes("'scheduled', 'in_progress'"), "cancelled/complete jobs are history");
  });

  it("rewrites ONLY rows that mirror the old address", () => {
    const write = cascade.slice(cascade.indexOf("UPDATE jobs j SET"));
    assert.ok(write.includes("AND ${mirrorsOld}"), "the write must carry the mirror test");
    assert.ok(!write.includes("NOT (${mirrorsOld})"), "one-off sites are counted, never rewritten");
  });

  it("bails out when the client had no address to mirror", () => {
    assert.ok(
      cascade.includes('if (!norm(before.address)) return { jobs_synced: 0, jobs_kept_own: 0 };'),
      "with no prior address nothing can be identified as a copy",
    );
  });

  it("re-stamps the geocode the map link and mileage engine read", () => {
    const write = cascade.slice(cascade.indexOf("UPDATE jobs j SET"));
    for (const col of ["job_lat", "job_lng", "address_lat", "address_lng"]) {
      assert.ok(write.includes(col), `${col} must follow the address or the pin stays at the old house`);
    }
  });
});

describe("PUT /clients/:id wires the cascade in", () => {
  it("snapshots the previous address before writing the new one", () => {
    const head = clients.slice(clients.indexOf('router.put("/:id"'), clients.indexOf("const updated = await db.update(clientsTable)"));
    assert.ok(head.includes("const prevAddress"), "the old address is what identifies a mirror");
    for (const f of ["address: clientsTable.address", "city: clientsTable.city", "state: clientsTable.state", "zip: clientsTable.zip"]) {
      assert.ok(head.includes(f), `previous ${f} must be selected`);
    }
  });

  it("never lets a cascade failure fail the profile save", () => {
    const block = clients.slice(clients.indexOf("if (addressChanged(prevAddress, nextAddress))"), clients.indexOf("// [AH] Per-field audit row"));
    assert.ok(block.includes("try {") && block.includes("catch (cascadeErr)"), "the save is the thing the office asked for");
  });

  it("reports the result so the office can see what was left behind", () => {
    assert.ok(clients.includes("...updated[0], address_sync"), "response must carry jobs_synced / jobs_kept_own");
  });
});
