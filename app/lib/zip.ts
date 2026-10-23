/**
 * A minimal ZIP writer (stored, no compression) for the data export. The files
 * are a few hundred KB of text at most, so skipping deflate keeps this tiny and
 * dependency-free; every unzip tool reads stored entries. Names are UTF-8
 * (general purpose flag bit 11), so Japanese titles survive.
 */

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  name: string;
  data: string | Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time (UTC fields of `date`, 2-second resolution, 1980 at the earliest). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getUTCFullYear(), 1980);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

const UTF8_FLAG = 0x0800;

/**
 * The 26 bytes the local header (at offset 4) and the central directory entry
 * (at offset 6) share: version needed, flags, method (0 = stored), time, date,
 * CRC, both sizes and the name length.
 */
function writeCommonHeader(view: DataView, at: number, f: { time: number; date: number; crc: number; size: number; nameLength: number }) {
  view.setUint16(at, 20, true);
  view.setUint16(at + 2, UTF8_FLAG, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, f.time, true);
  view.setUint16(at + 8, f.date, true);
  view.setUint32(at + 10, f.crc, true);
  view.setUint32(at + 14, f.size, true);
  view.setUint32(at + 18, f.size, true);
  view.setUint16(at + 22, f.nameLength, true);
  // Then the extra field length (0), here and in the central entry.
}

/** The archive holding `entries` in order, all stamped with `modified` (UTC). */
export function createZip(entries: ZipEntry[], modified: Date = new Date()): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(modified);
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const common = { ...stamp, crc: crc32(data), size: data.length, nameLength: name.length };

    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    writeCommonHeader(l, 4, common);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true); // version made by
    writeCommonHeader(c, 6, common);
    // comment length, disk, internal and external attributes: all 0
    c.setUint32(42, offset, true);
    central.set(name, 46);

    parts.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  parts.push(...centrals, end);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
