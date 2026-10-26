/**
 * Several files wrapped into one .zip, uncompressed ("stored"). For a road network that comes as
 * one zip per road class (Wellington: FC1-2, FC3, FC4, FC5): the import takes one archive per
 * layer, and the server opens zips inside a zip, so the zips chosen together go up as one.
 *
 * Stored, not deflated: the parts are zips already. No dependency — the format is a header per
 * file, the bytes, and a central directory.
 */

let table: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function zipFiles(files: File[], name: string): Promise<File> {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const used = new Set<string>();
  for (const file of files) {
    let fname = file.name;
    for (let n = 2; used.has(fname); n++) fname = file.name.replace(/(\.zip)?$/i, ` (${n})$1`);
    used.add(fname);
    const data = new Uint8Array(await file.arrayBuffer());
    const fn = enc.encode(fname);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, fn.length, true);
    parts.push(local.buffer, fn, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, fn.length, true);
    cd.setUint32(42, offset, true);
    const entry = new Uint8Array(46 + fn.length);
    entry.set(new Uint8Array(cd.buffer), 0);
    entry.set(fn, 46);
    central.push(entry);
    offset += 30 + fn.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new File([...parts, ...central, end.buffer], name, { type: 'application/zip' });
}
