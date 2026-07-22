// Sync the version from package.json into the other files that hard-code it.
// Runs automatically from the npm `version` lifecycle hook (see package.json),
// so `npm version <patch|minor|major|…>` keeps everything consistent and the
// changes land in the same version commit.
//
// package.json + package-lock.json are handled by `npm version` itself.
// The MCP server reports its version by reading package.json at runtime, so the
// only file that needs syncing here is server.json (the MCP registry manifest).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const serverPath = join(root, "server.json");
const server = JSON.parse(readFileSync(serverPath, "utf8"));
server.version = version;
if (Array.isArray(server.packages)) {
  for (const p of server.packages) p.version = version;
}
writeFileSync(serverPath, JSON.stringify(server, null, 2) + "\n");

console.log(`sync-version: server.json -> ${version}`);
