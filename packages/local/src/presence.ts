import { createHash } from "node:crypto";
import { createServer } from "node:net";

export async function holdPresence(folder: string, part: string): Promise<() => Promise<void>> {
  const hash = createHash("sha256").update(`${part}\n${process.platform === "win32" ? folder.toLowerCase() : folder}`).digest();
  const endpoint = process.platform === "win32"
    ? { path: `\\\\.\\pipe\\super-agent2-${hash.toString("hex")}` }
    : { host: "127.0.0.1", port: 20000 + hash.readUInt16BE() % 20000, exclusive: true };
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(`The ${part} presence socket for ${folder} is in use`);
    throw error;
  }
  return () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
