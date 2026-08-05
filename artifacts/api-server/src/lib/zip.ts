// [bulk-invoice-zip 2026-08-05] Minimal ZIP writer used to hand the office a
// folder of invoice PDFs in one download (Maribel: "select invoices and download
// in bulk generating a zip file with all the invoices separately").
//
// WHY hand-rolled instead of `archiver`: the only thing going into these
// archives is PDFs, which are ALREADY compressed — deflating them buys ~1-2%
// and costs a dependency on the Railway build. So this writes the STORE method
// (compression 0), which is a fixed, fully-specified layout: for each entry a
// local header + raw bytes, then a central directory, then the end-of-central-
// directory record. No streaming, no compression, no third-party code.
//
// Scope limits, deliberately: no Zip64, so an archive must stay under 4 GB and
// 65,535 entries. A month of invoice PDFs is a few MB across tens of files, and
// the routes cap the batch well below both ceilings.

// CRC-32 (IEEE 802.3), the checksum every ZIP entry carries. Table built once.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// MS-DOS date/time, the only timestamp a non-Zip64 ZIP header carries. Second
// resolution is 2s (the field stores seconds/2) and the epoch starts in 1980.
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface ZipEntry {
  /** Path inside the archive. Sanitized by `buildZip` — no leading slash, no `..`. */
  name: string;
  content: Buffer;
}

// Keep names portable across Finder / Windows Explorer: strip path traversal and
// the characters Windows refuses, and never emit an empty name.
function safeName(name: string, index: number): string {
  const cleaned = String(name || "")
    .replace(/[\\/]+/g, "-")          // no separators — an entry can never escape the extract dir
    .replace(/\.{2,}/g, ".")          // collapse ".." runs so no traversal marker survives at all
    .replace(/[:*?"<>|\x00-\x1f]/g, "") // characters Windows refuses in a filename
    .replace(/^[-.\s]+/, "")          // no leading dot (hidden file), dash, or space
    .trim();
  return cleaned || `file-${index + 1}`;
}

// De-duplicate names so two invoices that render the same filename don't
// collide into one entry (the second would silently overwrite the first on
// extract). "INV-1001.pdf" then "INV-1001 (2).pdf".
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) { taken.add(name); return name; }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
}

/**
 * Build a ZIP archive (STORE method) from in-memory entries.
 *
 * @param entries files to include; names are sanitized and de-duplicated
 * @param now     timestamp stamped on every entry (injectable so tests are deterministic)
 */
export function buildZip(entries: ZipEntry[], now: Date = new Date()): Buffer {
  if (entries.length > 0xffff) {
    throw new Error(`ZIP supports at most 65535 entries (got ${entries.length})`);
  }
  const { time, date } = dosDateTime(now);
  const taken = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  entries.forEach((entry, i) => {
    const name = Buffer.from(uniqueName(safeName(entry.name, i), taken), "utf8");
    const content = entry.content;
    const crc = crc32(content);

    // Local file header (30 bytes) + name, then the stored bytes.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);          // version needed (2.0)
    local.writeUInt16LE(0x0800, 6);      // flags: bit 11 = UTF-8 names
    local.writeUInt16LE(0, 8);           // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18); // compressed size
    local.writeUInt32LE(content.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length
    locals.push(local, name, content);

    // Central directory entry (46 bytes) + name, pointing back at the local header.
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0x0800, 8);     // flags: UTF-8 names
    central.writeUInt16LE(0, 10);         // method 0 = stored
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);         // extra field length
    central.writeUInt16LE(0, 32);         // comment length
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal attributes
    // External attributes: unix mode 0644 in the high 16 bits. `>>> 0` because
    // JS `<<` yields a SIGNED 32-bit int and 0o100644 << 16 goes negative.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);    // offset of local header
    centrals.push(central, name);

    offset += local.length + name.length + content.length;
  });

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);      // end-of-central-directory signature
  end.writeUInt16LE(0, 4);               // this disk
  end.writeUInt16LE(0, 6);               // disk with central directory
  end.writeUInt16LE(entries.length, 8);  // entries on this disk
  end.writeUInt16LE(entries.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);         // central directory offset
  end.writeUInt16LE(0, 20);              // comment length

  return Buffer.concat([...locals, centralBuf, end]);
}
