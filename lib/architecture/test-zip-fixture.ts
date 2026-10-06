import { deflateRawSync } from "node:zlib";

type FixtureFile = { name: string; text: string; mode?: number; declaredSize?: number; invalidDeflate?: boolean };

/** Small ZIP fixture writer so tests can model corrupt data, links and traversal explicitly. */
export function zipFixture(files: FixtureFile[], commit = "a".repeat(40)): Buffer {
  const locals: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), content = Buffer.from(file.text);
    const data = file.invalidDeflate ? Buffer.from([255, 255, 255]) : deflateRawSync(content);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.declaredSize ?? content.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(file.declaredSize ?? content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((file.mode ?? 0x81a4) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42); directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory), comment = Buffer.from(commit), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, central, end, comment]);
}

export const archiveResponse = (bytes: Buffer, etag = '"snapshot"') => new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/zip", ETag: etag } });
