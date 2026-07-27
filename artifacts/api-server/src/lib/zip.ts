// [photo-batch-download 2026-07-27] Dependency-free ZIP writer.
//
// The api-server bundle has no zip library and Node has no built-in one, so
// this builds a minimal ZIP archive by hand using the STORE method (no
// compression). That's the right call here: job photos are already-compressed
// JPEGs, so DEFLATE would add CPU for ~0% size win. Output is a standard .zip
// every OS opens natively.
//
// Format refs: PKWARE APPNOTE 4.3 — local file header (0x04034b50), central
// directory header (0x02014b50), end-of-central-directory (0x06054b50).

interface ZipEntry {
  name: string;
  data: Buffer;
}

// CRC-32 (IEEE 802.3), table-driven. Required in both the local and central
// headers or archives read as corrupt.
const CRC_TABLE: number[] = (() => {
  const t: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a STORE-method .zip from the given entries. Names are sanitized and
 *  de-duplicated so no two files collide inside the archive. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const used = new Set<string>();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const raw of entries) {
    // Sanitize: strip path separators + control chars, dedupe on collision.
    let name = (raw.name || "file")
      .replace(/[\\/]+/g, "_")
      .replace(/[^\x20-\x7E]/g, "")
      .trim() || "file";
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let i = 2;
      while (used.has(`${stem}-${i}${ext}`.toLowerCase())) i++;
      name = `${stem}-${i}${ext}`;
    }
    used.add(name.toLowerCase());

    const nameBuf = Buffer.from(name, "utf8");
    const data = raw.data;
    const crc = crc32(data);

    // Local file header.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = STORE
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    parts.push(local, nameBuf, data);

    // Central directory header (written after all locals).
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;

  // End of central directory.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
  eocd.writeUInt32LE(centralOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, centralBuf, eocd]);
}
