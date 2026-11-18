import { deflateSync } from "node:zlib";

const table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc(buffer: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = (table[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
}

export type Shape = "circle" | "square" | "triangle";

function inside(shape: Shape, size: number, x: number, y: number): boolean {
  const centre = size / 2;
  const reach = size * 0.32;
  switch (shape) {
    case "circle":
      return (x - centre) ** 2 + (y - centre) ** 2 < reach ** 2;
    case "square":
      return Math.abs(x - centre) < reach && Math.abs(y - centre) < reach;
    case "triangle":
      return y > centre - reach && y < centre + reach && Math.abs(x - centre) < (y - (centre - reach)) / 2;
  }
}

export function shapePng(size: number, shape: Shape, rgb: readonly [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const colour = inside(shape, size, x, y) ? rgb : [250, 250, 250];
      const at = y * (size * 3 + 1) + 1 + x * 3;
      rows[at] = colour[0] ?? 0;
      rows[at + 1] = colour[1] ?? 0;
      rows[at + 2] = colour[2] ?? 0;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
