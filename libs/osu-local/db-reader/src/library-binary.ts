import { TextDecoder } from "util";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Strict bounded primitives for library indexing, separate from the existing viewer readers. */
export class LibraryBinaryReader {
  position = 0;
  constructor(readonly bytes: Buffer) {
    if (bytes.length > 256 * 1024 * 1024) throw new Error("Database exceeds size limit");
  }
  take(length: number): number {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.position) throw new Error("Truncated database");
    const start = this.position; this.position += length; return start;
  }
  byte(): number { return this.bytes[this.take(1)]; }
  bool(): boolean { const value = this.byte(); if (value > 1) throw new Error("Invalid database boolean"); return value === 1; }
  short(): number { return this.bytes.readUInt16LE(this.take(2)); }
  int(): number { return this.bytes.readInt32LE(this.take(4)); }
  long(): string { return this.bytes.readBigInt64LE(this.take(8)).toString(); }
  float(): number { const value = this.bytes.readFloatLE(this.take(4)); if (!Number.isFinite(value)) throw new Error("Invalid database float"); return value; }
  double(): number { const value = this.bytes.readDoubleLE(this.take(8)); if (!Number.isFinite(value)) throw new Error("Invalid database double"); return value; }
  count(maximum: number): number { const value = this.int(); if (value < 0 || value > maximum) throw new Error("Database count exceeds limit"); return value; }
  string(): string {
    const marker = this.byte();
    if (marker === 0) return "";
    if (marker !== 11) throw new Error("Invalid database string marker");
    let length = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const part = this.byte(); length += (part & 127) * 2 ** shift;
      if (length > 128 * 1024) throw new Error("Database string exceeds limit");
      if (part < 128) { const start = this.take(length); return utf8.decode(this.bytes.subarray(start, start + length)); }
    }
    throw new Error("Invalid database string length");
  }
  md5(): string { const hash = this.string().toLowerCase(); if (!/^[a-f\d]{32}$/.test(hash)) throw new Error("Invalid database map MD5"); return hash; }
  finish(): void { if (this.position !== this.bytes.length) throw new Error("Unexpected trailing database bytes"); }
}

/** Project support fence for the documented layout, not an asserted upstream format transition. */
export function libraryDatabaseVersion(reader: LibraryBinaryReader): number {
  const version = reader.int();
  if (version < 20150204 || version > 20261016) throw new Error("Unsupported database version (supported project range: 20150204–20261016)");
  return version;
}
