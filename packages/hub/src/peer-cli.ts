import { parseArgs } from "node:util";
import { PeerName } from "@super-agent2/protocol";
import { cloudflareServiceTokens, cloudflareSettings } from "./cloudflare.js";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { peerHubUrl } from "./peer-link.js";
import { createPeerStore } from "./peer-store.js";

async function run(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { hub: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [command, given, ...rest] = positionals;
  const name = PeerName.safeParse(given);
  if (values.help) {
    console.log("Usage: node dist/peer-cli.js add <name> --hub <https-url> | revoke <name>");
    return;
  }
  if ((command !== "add" && command !== "revoke") || !name.success || rest.length > 0) {
    throw new Error("Use add or revoke with a peer name made of lower-case letters, digits and dashes.");
  }
  const loaded = loadConfig(process.env);
  if (!loaded.ok || loaded.config.accessPeerAudience === undefined) {
    throw new Error("Configure the hub and its separate ACCESS_PEER_AUD before managing peers.");
  }
  const cloudflare = cloudflareSettings(process.env);
  if ("missing" in cloudflare) throw new Error(`Cloudflare token management requires ${cloudflare.missing.join(" and ")}.`);
  const access = cloudflareServiceTokens(cloudflare, "peer");
  const database = openDatabase({ dataDir: loaded.config.dataDir, clock: systemClock });
  try {
    const store = createPeerStore(database);
    const existing = store.find(name.data);
    if (command === "revoke") {
      if (existing === undefined) throw new Error("No peer has that name.");
      store.remove(name.data);
      try {
        await access.remove(existing.accessTokenId);
      } catch {
        throw new Error(`The hub revoked ${name.data}. Delete its service token in Cloudflare as well.`);
      }
      console.log(`Revoked ${name.data}.`);
      return;
    }
    if (existing !== undefined) throw new Error("A peer with that name already exists. Revoke it before replacing its credentials.");
    const url = peerHubUrl(values.hub ?? process.env.HUB_PUBLIC_URL);
    if (url === undefined) throw new Error("Give the NAS HTTPS origin with --hub or HUB_PUBLIC_URL.");
    const service = await access.create(`superagent2-peer-${name.data}`);
    let token: string;
    try {
      token = store.add({ name: name.data, clientId: service.clientId, accessTokenId: service.id });
    } catch (error) {
      await access.remove(service.id);
      throw error;
    }
    console.log(`Paste these values into the local edition's local.env. The secrets are displayed once.\n${[
      `PEER_HUB_URL=${url}`, `PEER_ACCESS_CLIENT_ID=${service.clientId}`, `PEER_ACCESS_CLIENT_SECRET=${service.clientSecret}`, `PEER_TOKEN=${token}`,
    ].join("\n")}`);
  } finally {
    database.close();
  }
}

try {
  await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Peer command failed."}\n`);
  process.exitCode = 1;
}
