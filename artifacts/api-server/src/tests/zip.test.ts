/**
 * ZIP writer — structural regression tests for lib/zip.ts.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The bulk invoice download hands the office an archive built by hand rather
 * than by a library (see lib/zip.ts for why). A ZIP is a binary format with
 * offsets that point at each other: get one field wrong and the file still
 * "exists", still downloads, and still has a plausible size — it just won't
 * open, or worse, opens missing files. There is no runtime error to catch it.
 *
 * So the byte layout is pinned here. `unzip -t` was run against the real output
 * during the build; these tests are the cheap version that runs on every change.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildZip } from "../lib/zip.js";

// Fixed date so the DOS timestamp bytes are deterministic.
const T = new Date(2026, 7, 5, 12, 0, 0);

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;

// Walk the central directory the way an unzip tool does: seek the end record,
// then read each central entry. If our offsets are wrong, this throws.
function readCentralDirectory(zip: Buffer) {
  const eocdOffset = zip.length - 22; // no archive comment, so it's the last 22 bytes
  assert.equal(zip.readUInt32LE(eocdOffset), END_SIG, "end-of-central-directory signature not at the expected offset");
  const count = zip.readUInt16LE(eocdOffset + 10);
  const cdSize = zip.readUInt32LE(eocdOffset + 12);
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);
  assert.equal(cdOffset + cdSize, eocdOffset, "central directory does not end where the EOCD record begins");

  const entries: { name: string; size: number; localOffset: number; crc: number }[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(p), CENTRAL_SIG, `central entry ${i} has a bad signature`);
    const nameLen = zip.readUInt16LE(p + 28);
    entries.push({
      crc: zip.readUInt32LE(p + 16),
      size: zip.readUInt32LE(p + 24),
      name: zip.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
      localOffset: zip.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return entries;
}

// Pull an entry's bytes back out via its local header, as an extractor would.
function readEntryContent(zip: Buffer, localOffset: number) {
  assert.equal(zip.readUInt32LE(localOffset), LOCAL_SIG, "local header signature missing");
  const size = zip.readUInt32LE(localOffset + 18);
  const nameLen = zip.readUInt16LE(localOffset + 26);
  const extraLen = zip.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  return zip.subarray(start, start + size);
}

describe("zip writer — structure", () => {
  it("round-trips every entry's bytes exactly", () => {
    const files = [
      { name: "INV-1001.pdf", content: Buffer.from("%PDF-1.4 first") },
      { name: "INV-1002.pdf", content: Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]) }, // binary, incl. high bytes
      { name: "INV-1003.pdf", content: Buffer.alloc(0) },                              // empty file
    ];
    const zip = buildZip(files, T);
    const entries = readCentralDirectory(zip);

    assert.equal(entries.length, 3);
    files.forEach((f, i) => {
      assert.equal(entries[i].name, f.name);
      assert.equal(entries[i].size, f.content.length);
      assert.deepEqual(readEntryContent(zip, entries[i].localOffset), f.content);
    });
  });

  it("de-duplicates colliding filenames instead of dropping one", () => {
    // Two invoices rendering the same filename must both survive — a silently
    // overwritten entry is a missing invoice the office would never notice.
    const zip = buildZip([
      { name: "INV-1001.pdf", content: Buffer.from("one") },
      { name: "INV-1001.pdf", content: Buffer.from("two") },
      { name: "INV-1001.pdf", content: Buffer.from("three") },
    ], T);
    const entries = readCentralDirectory(zip);

    assert.deepEqual(entries.map((e) => e.name), ["INV-1001.pdf", "INV-1001 (2).pdf", "INV-1001 (3).pdf"]);
    assert.deepEqual(readEntryContent(zip, entries[1].localOffset).toString(), "two");
    assert.deepEqual(readEntryContent(zip, entries[2].localOffset).toString(), "three");
  });

  it("strips path traversal out of entry names", () => {
    // Names reach the archive from invoice numbers. An entry called
    // "../../etc/passwd" must never be able to escape the extraction directory.
    const zip = buildZip([{ name: "../../etc/passwd", content: Buffer.from("x") }], T);
    const [entry] = readCentralDirectory(zip);
    assert.ok(!entry.name.includes(".."), `name still contains traversal: ${entry.name}`);
    assert.ok(!entry.name.includes("/"), `name still contains a separator: ${entry.name}`);
  });

  it("never emits an empty entry name", () => {
    const zip = buildZip([{ name: "", content: Buffer.from("x") }], T);
    const [entry] = readCentralDirectory(zip);
    assert.equal(entry.name, "file-1");
  });

  it("computes a real CRC-32 per entry", () => {
    // Known-answer test: CRC-32 of "123456789" is the standard 0xCBF43926.
    const zip = buildZip([{ name: "a.txt", content: Buffer.from("123456789") }], T);
    const [entry] = readCentralDirectory(zip);
    assert.equal(entry.crc, 0xcbf43926);
  });

  it("writes external attributes as an unsigned 32-bit value", () => {
    // Regression: unix mode 0644 shifted left 16 overflows a SIGNED int in JS,
    // and Buffer.writeUInt32LE throws on the negative. Building at all is the
    // assertion; an empty archive is also valid and must not throw.
    assert.doesNotThrow(() => buildZip([{ name: "a.pdf", content: Buffer.from("x") }], T));
    assert.doesNotThrow(() => buildZip([], T));
  });

  it("refuses more entries than a non-Zip64 archive can address", () => {
    const tooMany = Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}`, content: Buffer.alloc(0) }));
    assert.throws(() => buildZip(tooMany, T), /at most 65535 entries/);
  });
});
