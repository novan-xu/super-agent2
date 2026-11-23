import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const version = "159.0.8154.6";
const archives: Readonly<Partial<Record<string, readonly [platform: string, sha256: string]>>> = {
  "darwin:arm64": ["mac-arm64", "b08e7beaf02a19e2ee5ed6955f9c3853ab9176cd5bb57ba87afbb82e9f81cc29"],
  "darwin:x64": ["mac-x64", "89c56fb080ab4e9ba76656d5669af2b2dfc313c11434871e8f4e351c08a5ffca"],
  "win32:x64": ["win64", "5db6a6948e6d1299ea3bc87c420d467bf343feae186a316921c930ce02056af5"],
  "linux:x64": ["linux64", "77a6442fd3c8acd3bef9e1067fc26f5ef464277d22f0e8cb58dc3e4077a3e458"],
};

function chromeArchive() {
  const entry = archives[`${process.platform}:${process.arch}`];
  if (entry === undefined) throw new Error(`Chrome Headless Shell is unavailable for ${process.platform} ${process.arch}`);
  const [platform, sha256] = entry;
  const root = resolve(process.env.SUPERAGENT2_ARTIFACTS_DIR || join(homedir(), ".cache", "super-agent2"), "chromium");
  const directory = join(root, `${version}-${platform}`);
  const folder = `chrome-headless-shell-${platform}`;
  const executable = join(directory, folder, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
  return { root, directory, executable, folder, platform, sha256 };
}

export function chromiumExecutable(): string {
  const { executable } = chromeArchive();
  if (!existsSync(executable)) throw new Error(`Chrome Headless Shell ${version} is missing. Run pnpm browser:install.`);
  return executable;
}

async function install(): Promise<void> {
  const { root, directory, executable, folder, platform, sha256 } = chromeArchive();
  if (existsSync(executable)) return;
  await mkdir(root, { recursive: true });
  const scratch = await mkdtemp(join(root, "download-"));
  try {
    process.stdout.write(`Downloading Chrome Headless Shell ${version} for ${platform}\n`);
    const response = await fetch(`https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/${folder}.zip`);
    if (!response.ok || response.body === null) throw new Error(`Chrome download failed with HTTP ${response.status}`);
    const zip = join(scratch, `${folder}.zip`);
    const hash = createHash("sha256");
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(Readable.from(response.body), hashing, createWriteStream(zip));
    if (hash.digest("hex") !== sha256) throw new Error(`Checksum mismatch for ${folder}.zip`);

    const extracted = join(scratch, "extracted");
    await mkdir(extracted);
    if (process.platform === "win32") {
      execFileSync("tar.exe", ["-xf", zip, "-C", extracted], { stdio: "inherit" });
    } else {
      execFileSync("unzip", ["-q", zip, "-d", extracted], { stdio: "inherit" });
    }
    try {
      await rename(extracted, directory);
    } catch (error) {
      if (!existsSync(executable)) throw error;
    }
    chromiumExecutable();
    process.stdout.write(`Installed Chrome Headless Shell ${version} at ${directory}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) await install();
