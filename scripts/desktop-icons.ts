import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function icon(size: number): Buffer {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x / size;
      const py = y / size;
      let color = [24, 104, 87, 255];
      const page = px > 0.19 && px < 0.81 && py > 0.23 && py < 0.78;
      if (page) color = [246, 249, 247, 255];
      if (page && Math.abs(px - 0.5) < 0.014) color = [24, 104, 87, 255];
      if (page && px > 0.6 && px < 0.69 && py < 0.46) color = [225, 104, 91, 255];
      if (page && px > 0.26 && px < 0.43 && [0.39, 0.49, 0.59].some(line => Math.abs(py - line) < 0.012)) color = [87, 115, 107, 255];
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 4; c++) pixels[offset + c] = color[c]!;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

export async function generateDesktopIcons(): Promise<void> {
  const directory = resolve(root, "apps/desktop/src-tauri/icons");
  await mkdir(directory, { recursive: true });
  await mkdir(resolve(root, "apps/desktop/ui"), { recursive: true });
  await writeFile(resolve(directory, "32x32.png"), icon(32));
  await writeFile(resolve(directory, "128x128.png"), icon(128));
  await writeFile(resolve(root, "apps/desktop/ui/brand.png"), icon(128));
  const png = icon(256);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  await writeFile(resolve(directory, "icon.ico"), Buffer.concat([header, png]));
}
