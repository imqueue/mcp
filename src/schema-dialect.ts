// The JSON Schema dialect this server advertises, and the reason it is not the
// SDK's.
//
// THIS IS WHY THE DOCS TOOLS DID NOT WORK IN CLAUDE CODE. Every tool that declares
// an `outputSchema` was rejected outright by the Claude Code / Agent SDK client:
//
//   Tool 'search_docs' has an invalid outputSchema: JSON Schema declares an
//   unsupported dialect ("$schema": "http://json-schema.org/draft-07/schema#").
//   The default validator supports JSON Schema 2020-12 only
//
// That is search_docs, get_doc, list_packages, scaffold_service and scaffold_client
// — the whole shared surface, and five of the six tools the hosted endpoint offers.
// `cli_help` and its siblings kept working precisely because they declare no
// `outputSchema`, which is what made the pattern legible. An agent that hits this
// falls back to a search engine, which is the exact failure the MCP server exists
// to prevent.
//
// The cause is upstream and not configurable. `@modelcontextprotocol/sdk` converts
// the zod shapes we register at `tools/list` time through
// `server/zod-json-schema-compat.js`, and that function takes a `target` option —
// but `server/mcp.js` never passes one, so `mapMiniTarget(undefined)` returns
// 'draft-7' for BOTH the zod v3 path (`zod-to-json-schema`) and the zod v4 path
// (`z4mini.toJSONSchema`). Verified identical in 1.29.0 and 1.30.0, so neither an
// SDK bump nor a move to zod v4 fixes it. There is no public seam.
//
// So the server relabels its own schemas on the way out. That is only honest if the
// schemas really are readable as 2020-12, which is why `toCurrentDialect` REFUSES
// rather than relabels when it meets a construct whose meaning differs between the
// two drafts. Today every schema this server advertises is plain
// type/properties/required/items/additionalProperties/description — identical under
// both drafts — and the guard is what keeps that true after the next tool is added.

/** The dialect every advertised schema declares. */
export const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * Keywords that mean something different — or nothing — under 2020-12, so a
 * schema using one cannot be relabelled without changing what it says.
 *
 *   definitions            renamed to `$defs`; a `$ref` written against it dangles.
 *   dependencies           split into `dependentSchemas` / `dependentRequired`.
 *   exclusiveMinimum/Maximum  a BOOLEAN modifier in draft-4, a number since draft-6.
 *                          Only the boolean spelling is a conflict; a numeric one
 *                          means the same thing in both, so the value is checked
 *                          rather than the key.
 *   items (as an array)    tuple form; `prefixItems` since 2020-12. An `items`
 *                          holding a single schema is the same in both.
 *
 * Not exhaustive for JSON Schema at large — exhaustive for what a zod shape can
 * produce through the SDK's converter, which is the only input this ever sees.
 */
function conflict(key: string, value: unknown): string | null {
  if (key === "definitions") return "`definitions` was renamed to `$defs` in 2020-12";
  if (key === "dependencies") return "`dependencies` was split into `dependentSchemas`/`dependentRequired` in 2020-12";
  if ((key === "exclusiveMinimum" || key === "exclusiveMaximum") && typeof value === "boolean") {
    return `\`${key}\` as a boolean is draft-4 spelling; 2020-12 takes a number`;
  }
  if (key === "items" && Array.isArray(value)) return "tuple-form `items` became `prefixItems` in 2020-12";

  return null;
}

/**
 * Relabel a JSON Schema as 2020-12, in place, throwing if it says anything that
 * would not survive the relabelling.
 *
 * Nested `$schema` keys are dropped rather than rewritten: a dialect declaration
 * belongs on the root, and a subschema carrying its own is noise that some
 * validators treat as a resource boundary.
 *
 * @param schema  A JSON Schema object, as produced by the SDK's zod converter.
 * @param where   Tool name, for the error message — a throw with no subject here
 *                surfaces as a broken `tools/list` with nothing to grep for.
 * @returns The same object, relabelled.
 */
export function toCurrentDialect<T>(schema: T, where: string): T {
  const walk = (node: unknown, root: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, false);

      return;
    }
    if (!node || typeof node !== "object") return;

    const obj = node as Record<string, unknown>;

    for (const [key, value] of Object.entries(obj)) {
      const why = conflict(key, value);

      if (why) {
        throw new Error(
          `${where}: cannot advertise this schema as ${DIALECT} — ${why}. ` +
            "Express it another way, or teach src/schema-dialect.ts how to translate it.",
        );
      }
      walk(value, false);
    }

    if (root) obj.$schema = DIALECT;
    else delete obj.$schema;
  };

  walk(schema, true);

  return schema;
}
