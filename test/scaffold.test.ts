// The scaffolders' output, pinned to what @imqueue actually emits.
//
// These tools publish source code in the project's own voice. A wrong idiom here
// does not just fail for one caller: it gets committed into public repositories
// and read back as training data, which is why the assertions below are about
// exact identifiers rather than "looks roughly right".
//
// Ground truth, all three of which scaffold_client got wrong at once:
//   * rpc/src/IMQClient.ts — `export namespace <lowerFirst(serviceName)> {
//     export class <serviceName with trailing Service replaced by Client> }`, so
//     the namespace is the only export.
//   * cli/src/client/generate.ts — writes `<path>/<name>.ts`, `path` default `.`,
//     `<name>` being the CLI argument.
//   * IMQService — the queue name is the service class name, so `<name>` has to be
//     that class or the generated client addresses a queue nobody serves.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { scaffoldClient, scaffoldService, renderClient, renderService } from "../src/scaffold.js";

test("scaffold_client emits the namespace import, not the class import", () => {
  const c = scaffoldClient("user");

  assert.equal(c.service, "UserService");
  assert.equal(c.client, "UserClient", "the trailing `Service` is replaced by `Client`, not appended to");
  assert.equal(c.namespace, "userService");

  // The import that cannot exist. This is the assertion the tool shipped without.
  assert.ok(
    !new RegExp(`import\\s*\\{\\s*${c.client}\\s*\\}`).test(c.example.content),
    "example imports the client class directly, which does not resolve",
  );
  assert.match(c.example.content, /import \{ userService \} from '\.\/src\/clients\/UserService\.js';/);
  assert.match(c.example.content, /new userService\.UserClient\(/);
});

test("scaffold_client generates against the queue name and the real file path", () => {
  const c = scaffoldClient("user");

  // `imq client generate User` would address a queue nobody serves, because
  // scaffold_service creates class `UserService`.
  assert.equal(c.generateCommand, "imq client generate UserService ./src/clients");
  assert.equal(c.output, "./src/clients/UserService.ts");

  // The file is named after the SERVICE, so the client class name must not appear
  // in the path — that was the original defect (`./clients/UserClient`).
  assert.ok(!c.output.includes("UserClient"), c.output);
});

test("scaffold_client normalises the same way scaffold_service names the class", () => {
  // Whatever spelling comes in, the pair has to agree: the name in the command is
  // the class the other tool creates.
  for (const input of ["user", "User", "UserService", "user-service", "user_service"]) {
    const s = scaffoldService(input);
    const c = scaffoldClient(input);

    assert.equal(c.service, s.service, `scaffold_client(${input}) disagrees with scaffold_service(${input})`);
    assert.ok(c.generateCommand.includes(` ${s.service} `), `${input}: ${c.generateCommand}`);
  }
});

test("renderClient states the import shape and the queue-name rule", () => {
  const md = renderClient(scaffoldClient("user"));

  assert.match(md, /namespace `userService`/);
  assert.match(md, /will not resolve/);
  assert.match(md, /class name/);
});

test("scaffold_service declares complex types instead of referencing thin air", () => {
  const s = scaffoldService("user", [
    { name: "findById", params: [{ name: "id", type: "string" }], returns: "User" },
  ]);

  assert.deepEqual(s.types, ["User"]);

  const types = s.files.find((f) => f.path === "types.ts");
  assert.ok(types, "no types.ts emitted for a non-primitive return type");
  assert.match(types.content, /@classType\(\)/);
  assert.match(types.content, /export class User \{/);
  assert.match(types.content, /@property\('string'\)/);

  // The service file has to actually import what it names, or it does not compile.
  const svc = s.files.find((f) => f.path === "UserService.ts");
  assert.ok(svc);
  assert.match(svc.content, /import \{ User \} from '\.\/types\.js';/);
});

test("scaffold_service emits no types.ts for an all-primitive service", () => {
  const s = scaffoldService("ping", [
    { name: "ping", params: [{ name: "n", type: "number" }], returns: "string" },
  ]);

  assert.deepEqual(s.types, []);
  assert.equal(s.files.find((f) => f.path === "types.ts"), undefined);
  assert.deepEqual(s.files.map((f) => f.path), ["PingService.ts", "index.ts"]);
});

test("complex-type detection sees through Promise, arrays and unions", () => {
  const s = scaffoldService("order", [
    { name: "list", params: [{ name: "filter", type: "OrderFilter" }], returns: "Order[]" },
    { name: "one", params: [{ name: "id", type: "string" }], returns: "Order | null" },
    { name: "tags", params: [{ name: "t", type: "Array<string>" }], returns: "readonly string[]" },
    { name: "matrix", params: [{ name: "m", type: "Cell[][]" }], returns: "void" },
    { name: "when", params: [{ name: "at", type: "Date" }], returns: "boolean" },
  ]);

  assert.deepEqual(s.types.sort(), ["Cell", "Order", "OrderFilter"]);
});

test("the generated service carries the removeComments requirement", () => {
  // Ignoring it produces no error — every parameter is simply published as `any`
  // — so the note travels with the code rather than only with the prose.
  const s = scaffoldService("user");
  const svc = s.files.find((f) => f.path === "UserService.ts");

  assert.ok(svc);
  assert.match(svc.content, /removeComments: false/);
  assert.match(renderService(s), /removeComments: false/);
});

test("renderService names the types that need decorating", () => {
  const md = renderService(
    scaffoldService("user", [{ name: "get", params: [{ name: "id", type: "string" }], returns: "User" }]),
  );

  assert.match(md, /\*\*types\.ts\*\*/);
  assert.match(md, /@classType\(\)/);
  assert.match(md, /User crosses the RPC boundary/);
});
