// `tools/list`, read off the real wire.
//
// Through an in-memory client rather than the server's private fields, because what a
// directory reviewer inspects is the serialised `tools/list` output: a value set
// internally but not serialised would pass an introspection test and fail the review.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, type CliHandlers, type Mode } from "../../src/server.js";

/** Stub handlers, so local mode registers the CLI tools without an `imq` binary. */
const stubCli = new Proxy({}, { get: () => async () => "" }) as CliHandlers;

/**
 * Every tool the server lists in a given mode.
 *
 * @param mode - `remote` for the hosted surface, `local` for the full one
 * @param clientName - reported to the server as the connecting client
 */
export async function listTools(mode: Mode, clientName = "list-tools-test") {
  const server = createServer({ version: "0.0.0-test", mode, cli: mode === "local" ? stubCli : undefined });
  const client = new Client({ name: clientName, version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const { tools } = await client.listTools();

  await client.close();

  return tools;
}
