# @imqueue/mcp — design spec

## 1. Purpose

Make @imqueue **first-class inside AI coding agents**. When a developer asks their
assistant to "build an @imqueue service" or "how do I expose a method", the agent
should reach for authoritative docs and correct scaffolding rather than
hallucinating an API. This is the GEO (Generative Engine Optimization) counterpart
to SEO: instead of ranking in a search page, we rank **at code-time**, inside the
tools developers already use.

Three capabilities, thirteen tools locally:

- **Docs access** — `search_docs`, `get_doc`, `list_packages`
- **Offline scaffolding** — `scaffold_service`, `scaffold_client` (templates, no deps)
- **CLI bridge** — `cli_status`, `cli_install`, `cli_help`, `create_service`,
  `generate_client`, `fleet` (`imq ctl`), `config` (`imq config`), `logs` (`imq log`)
  (drive the installed `imq` binary — install it, create projects, generate clients,
  manage the local fleet and CLI configuration)

The first two capabilities are read-only and run anywhere; the CLI bridge acts on the
machine the server runs on, so the hosted endpoint carries the first two plus a
`local_install_guide` and nothing else — six read-only tools.

## 2. Architecture

```
AI agent (Claude Code / Cursor / …)
        │  MCP (JSON-RPC over stdio)
        ▼
  @imqueue/mcp  ── fetch ──▶  imqueue.org
   ├─ docs.ts       (/llms.txt, /<page>/index.md)
   ├─ packages.ts   (static catalog)
   └─ scaffold.ts   (code templates)
```

- **Transport:** stdio (the universal local-MCP transport; works with every host
  today). The hosted **Streamable HTTP** variant since planned in §7 now exists at
  `mcp.imqueue.org/mcp`; it shares this code and serves the read-only subset
  (docs + scaffolding + a local-install guide), because the CLI-backed tools act on
  the caller's own machine. See `worker/README.md`.
- **Runtime:** Node ≥ 18, TypeScript, `@modelcontextprotocol/sdk` high-level
  `McpServer`, `zod` input schemas. Ships as an npm bin (`npx -y @imqueue/mcp`).
- **Docs source:** fetched live from the sites' existing machine-readable feeds and
  cached in-process (1 h TTL), with a 5 s per-request timeout and a fall back to the
  stale copy rather than an error. No docs are bundled, so the server can never go
  stale against a release. **Only `imqueue.org` and `imqueue.com` are ever fetched**
  (host-checked).

### Why reuse the site feeds
imqueue.org already emits, for GEO:
- `/llms.txt` — curated index (`## Section` + `- [Title](url): description`)
- `/api/search-index.json` — every exported symbol of the current majors
- `/<page-url>index.md` and `/<page-url>.md` — a plain-markdown mirror of every page
- `/blog/search-index.json` — structured post index

imqueue.com emits its own `/llms.txt` and mirrors, covering licensing, pricing and
support — the questions the framework docs deliberately do not answer, and therefore
the ones this server could not answer while it read one site.

The MCP server is a thin, agent-facing adapter over those — one source of truth.

## 3. Tools

### `search_docs(query, limit?=6, package?)`
Parse both `/llms.txt` feeds (imqueue.org for the framework, imqueue.com for
licensing/pricing/support) plus `/api/search-index.json` into
`{title, url, description, section, symbol?}` entries, then rank them.

Ranking is **IDF-weighted**, not flat overlap: every term's contribution is scaled by
how rare it is across the corpus, because every page here is about @imqueue services
and `imqueue`/`service`/`queue` say nothing about which page answers the question.
On top of that:

- Titles match on identifier **segments** — `MigrateDownOptions` yields
  `migrate`/`down`/`options` — so a term cannot match the middle of a longer word.
  An exact segment scores as a whole token, a prefix of one scores less, and
  fragments under four characters score nothing.
- Inflections (`-s/-es/-ies`, `-ing`, `-ed`, `-tion/-sion`) are expanded on both the
  query and the corpus and matched form-to-form, and discounted relative to the word
  as written. No synonym map.
- A symbol page can match on its **summary** alone, weakly; a symbol's **package**
  (which lives in its section) is scored, so `package`-style queries work and the
  optional `package` filter scopes a search to one of a mutually exclusive pair.
- Blog posts are demoted by a **multiplier**, not a sort key, so a decisively better
  article can still lead while a doc page wins a near-tie.
- Per-parent AND per-member-name caps stop one class, or one method name repeated
  across six classes, filling the answer.
- A miss returns the corpus's section names and the indexed terms nearest the query,
  because zero results with no guidance is positive evidence to a model that the
  topic is not covered.

→ *"how do I expose a method" → the RPC guide + API pages.*

### `get_doc(url)`
Resolve a page URL to its markdown mirror (`…/index.md`, or `<page>.md`) and return
the raw markdown for reading/quoting. A URL that already names a file
(`/llms-full.txt`, `/blog/feed.xml`) is fetched as-is. Host-restricted to
imqueue.org and imqueue.com; a commercial page with no mirror returns a pointer
rather than an error. Bodies over 200 kB are truncated, which the result reports.

### `list_packages()`
Static catalog of every **documented** package with one-liners, install commands and,
where two packages cover the same ground, an explicit `pick` rule — so the agent
picks the right one first instead of choosing on wording. `@imqueue/js`,
`@imqueue/travis` and `@imqueue/mcp` are published but deliberately undocumented and
are not listed.

### `scaffold_service(name, methods?)`
Emit an `IMQService` subclass with `@expose()`d, **JSDoc-typed** methods (JSDoc is
@imqueue's type source) + a bootstrap that `start()`s it, and — for any non-primitive
parameter or return type — a `types.ts` with the `@classType()`/`@property()`
declarations that type needs. Omitting `methods` yields a starter template. Points to
`imq service create` for a fully provider-wired project.

### `scaffold_client(service, methods?)`
@imqueue generates the **real** typed client from a **running** service, so types
never drift. The tool returns that command plus an illustrative usage snippet (it
does not fabricate a client that could go stale). Every identifier it emits is pinned
by `test/scaffold.test.ts` against `IMQClient`'s generator and the CLI's writer: the
file is named after the **service**, the CLI argument is the service's **class name**
because that is its queue name, and the module's only export is a **namespace**
holding the client class.

### CLI bridge — `cli_status`, `cli_help`, `create_service`, `generate_client`
The server runs locally, so when `@imqueue/cli` is on PATH it can drive the **real**
`imq` (see `src/cli.ts`). Safety posture:
- Every call runs `imq` with **stdin closed and a timeout**, so an interactive prompt
  (a missing flag) fails fast with guidance rather than hanging the server.
- `create_service` runs `imq service create … --dry-run` **by default** (writes
  nothing); a real run requires an explicit `apply: true` — an agent must never
  create repos / push to remotes silently. `cli_help` surfaces the exact flags to
  pass so the run is non-interactive.
- `generate_client` runs `imq client generate` (the service must be running).
- `cli_install` runs `npm install -g @imqueue/cli` to bootstrap the CLI when absent.
- `fleet` wraps `imq ctl <start|stop|restart|status>` (status is read-only; the
  others change running processes).
- `config` wraps `imq config <check|get|set|init>` (get/check read-only; set writes a
  single value; init is interactive so automation should prefer set).
- If `imq` is absent, the tools return an install hint and the offline `scaffold_*`
  tools remain available.

## 3a. Tool annotations, and why each is set that way

All four hints the spec defines are set explicitly on all thirteen tools — never
omitted, never null. `test/annotations.test.ts` asserts that through a real
`tools/list` call and pins every value in the table below, so a change of judgement
has to be made deliberately and shows up in a diff as a claim about behaviour.

Two things worth stating because they are easy to read as contradictions:

- **`destructive` and `idempotent` are not opposites.** `cli_install` replaces
  whatever `imq` was installed, which is destructive; installing the same version
  twice lands the same binary, so all the destruction happens in the first call and
  the second adds none.
- **`openWorld` and `idempotent` answer different questions.** `get_doc` may return
  different bytes on two calls because the page changed — that is what
  `openWorldHint: true` says. It still changes nothing by being called twice.

| Tool | read-only | destructive | idempotent | open-world | Justification |
|---|:--:|:--:|:--:|:--:|---|
| `search_docs` | ✅ | ❌ | ✅ | ✅ | Fetches public pages from imqueue.org/imqueue.com and ranks them. Reads only; the sites change between calls, so open-world. |
| `get_doc` | ✅ | ❌ | ✅ | ✅ | Fetches one page's markdown. Host-locked to the two @imqueue domains; refuses anything else. |
| `list_packages` | ✅ | ❌ | ✅ | ❌ | Renders a catalogue compiled into the build. No network, no filesystem. |
| `scaffold_service` | ✅ | ❌ | ✅ | ❌ | **Returns source code as text.** Writes no file, creates no project, runs no command — the caller decides whether anything is ever written. `create_service` is the tool that writes. |
| `scaffold_client` | ✅ | ❌ | ✅ | ❌ | **Returns text**, including the `imq client generate` command as a string. It does not run it. `generate_client` is the tool that does. |
| `local_install_guide` | ✅ | ❌ | ✅ | ❌ | Returns static setup instructions. Installs nothing — which is why it is not called `install_locally`. |
| `cli_status` | ✅ | ❌ | ✅ | ❌ | Detects the local `imq` binary and reports its version. |
| `cli_help` | ✅ | ❌ | ✅ | ❌ | Runs `imq <command> --help`, which prints and exits. |
| `create_service` | ❌ | ❌ | ❌ | ✅ | Dry-run by default; with `apply: true` it writes a project and may init git, wire CI and push to a remote — hence open-world. Not destructive: it creates rather than damages. **Not idempotent:** a second apply meets a populated directory and can create a second repository. |
| `generate_client` | ❌ | ❌ | ✅ | ✅ | Introspects a **running** service over its queue (open-world) and overwrites two files at a fixed path. A repeat leaves the same state, so idempotent. |
| `cli_install` | ❌ | ✅ | ✅ | ✅ | `npm install -g @imqueue/cli` — downloads from the npm registry and **replaces any existing `imq`**, so destructive. Idempotent: see the note above. |
| `fleet` | ❌ | ✅ | ❌ | ❌ | `imq ctl` over local service repos. `status` is read-only but `stop`/`restart` kill running processes, and a hint describes the tool's **worst case**. Not idempotent: `restart` twice restarts twice, dropping in-flight work each time. |
| `config` | ❌ | ✅ | ❌ | ❌ | `imq config set` overwrites a value and `init` rewrites the file. Not idempotent because `init` is interactive and a repeat is not guaranteed to be a no-op. |
| `logs` | ❌ | ✅ | ❌ | ❌ | `dump` reads; `clean` **deletes** the collected logs. Not idempotent: a running fleet writes logs continuously, so a second `clean` deletes *different* data — a client must not auto-retry it. |

The hosted surface is the first eight rows minus the two `cli_*` entries — six tools,
every one `readOnlyHint: true` and `idempotentHint: true`. Nothing that changes state
is registered there at all, because a server on Cloudflare's edge cannot reach the
caller's machine; see §2 and `worker/README.md`.

**On the two `scaffold_*` names.** "Scaffold" means "write files" in most tooling, so
a reader who stops at the name would conclude `readOnlyHint: true` is wrong. It is
not — they return strings — but appearance is what a reviewer judges, so both
descriptions now open with `READ-ONLY: returns … and writes nothing to disk`, and
each points at the CLI-backed tool that does the real thing.

## 4. Schemas (zod)

Input:

- `search_docs`: `{ query: string (1..200), limit?: 1..20, package?: string }`
- `get_doc`: `{ url: string }`
- `list_packages`: `{}`
- `scaffold_service` / `scaffold_client`: `{ name|service: string, methods?: Method[] }`
  where `Method = { name, description?, params?: {name,type,description?,optional?}[], returns? }`.

Output: every tool returns `{ content: [{ type: "text", text }] }`, and errors return
the same shape with `isError: true` (so the agent sees a message, not a transport
failure). The five **shared** tools additionally declare an `outputSchema` and return
`structuredContent`:

| Tool | `structuredContent` |
|---|---|
| `search_docs` | `{ query, count, results[{title, section, description, url, symbol?}] }` |
| `get_doc` | `{ url, markdown, mimeType, bytes, truncated, section?{heading, ancestors[], index, total}, fragmentMiss?{anchor, available[]} }` — the body is in **both** `markdown` and `content`, deliberately: the spec frames `content` as the backwards-compatible mirror of the structured result, so a client that renders `structuredContent` when present is entitled to ignore `content`, and a metadata-only schema handed it a citable URL with no page behind it. `section` and `fragmentMiss` mirror the header lines for the same reason — they are what stops a slice being mistaken for the whole page |
| `list_packages` | `{ packages[{name, install, summary, pick?}] }` |
| `scaffold_service` | `{ service, install, files[{path, language, content}], types[], cliAlternative }` |
| `scaffold_client` | `{ service, client, namespace, generateCommand, output, example{language, content} }` |

For the scaffolders and the catalogue the markdown is rendered *from* that structure,
so prose and data cannot disagree. The CLI-bridge tools declare no `outputSchema`:
they return `imq` stdout, which has no shape worth promising.

## 5. Distribution to registries

Publish `@imqueue/mcp` to npm, then list it everywhere agents discover servers:

A channel with no status is a channel nobody can tell is done, so every row carries
one. Re-verify before quoting any of them: a listing can be auto-indexed and then go
stale, which is how Context7 came to serve a superseded safety model in the project's
own voice.

| Channel | Artifact / action | Status (verified 2026-08-03) |
|---|---|---|
| **Official MCP registry** | `server.json` (this repo) → publish via `mcp-publisher`. Namespace `org.imqueue/mcp` (DNS auth on imqueue.org). | **done**, automated in `postpublish` |
| **Smithery** | `smithery.yaml` (this repo) → connect the GitHub repo. | listed, but advertises CLI tools the hosted server does not serve — convert to a declared remote |
| **Glama / LobeHub** | Auto-index from npm + GitHub. | indexed, stale — needs a re-scrape |
| **Context7** | Submit imqueue.org; `context7.json` is the rules block it serves to agents. | indexed at an old revision; refresh needed, and a refresh ping belongs in `postpublish` |
| **mcp.so / PulseMCP / Docker MCP Catalog / mcp-get** | Submit the listing. | **absent** — verified 404/zero-result on all four |
| **awesome-mcp-servers** (appcypher, wong2) | PR the repo into the list. | **absent** |
| **Cline marketplace** | `llms-install.md` (this repo, current). | **absent**; optional, since it already works from a repo URL |
| **Cursor / VS Code directories** | The GitHub/VS Code gallery pulls from the official registry. | expected to arrive on its own |
| **Anthropic Connectors Directory** | No auth, six read-only tools with hints, privacy + terms + docs pages all 200. | technically ready; blocked on a non-technical prerequisite — the portal needs a Team/Enterprise org with directory-management access |
| **OpenAI apps** | Domain-verification token live at `/.well-known/openai-apps-challenge`. | **draft, under review** — the reason this branch does not publish |
| **imqueue.org** | "MCP server" section on `/using-ai-assistants/` with the install snippet. | **done** |

Install snippet promoted everywhere:
```json
{ "mcpServers": { "imqueue": { "command": "npx", "args": ["-y", "@imqueue/mcp"] } } }
```

## 6. Verification

Three layers, because each catches what the others cannot.

`npm test` runs the unit tests (`node:test` under tsx, type-checked by
`tsconfig.test.json`). This is where anything whose correctness does not depend on the
network lives: the ranker on a fixed corpus, the scaffolders' emitted identifiers, URL
resolution, telemetry, and the Worker's HTTP surface — `worker.ts` is a plain
Web-Standard fetch handler, so it is called with a `Request` and asserted on the
`Response`, with no wrangler and no deploy.

`npm run smoke` spawns the built stdio server and drives the JSON-RPC handshake:
`initialize` (asserting `instructions` and a `title`) → `tools/list` (the exact local
tool list, a title and all three behaviour hints on every tool, and which tools do and
do not declare an `outputSchema`) → `tools/call` for the offline tools, plus live
ranking checks that only a real 1,500-entry corpus exercises.

`npm run smoke:remote [url]` does the same for the hosted endpoint, where the
contract is stricter: the exact six-tool list, `readOnlyHint: true` on all of them,
the search → get_doc chain on structured data alone, and the method handling
(`GET`/`DELETE` → 405, `HEAD /` → 200) that a hang would otherwise reach production
with.

`npm run verify` runs all of it plus both type-checks.

## 7. Roadmap

- ~~**Streamable HTTP** deployment (a hosted endpoint) for zero-install use and for
  hosts that prefer remote servers.~~ — shipped: `mcp.imqueue.org/mcp`.
- ~~**Richer search** — light stemming to improve recall.~~ — shipped: inflection
  expansion, segment-aware title matching, summary and package scoring, and a
  `package` filter. Folding in `/blog/search-index.json` topics is still open.
- **`generate_client` for real** — spin up against a reachable running service and
  return the actual generated client.
- **Resources** — expose docs pages as MCP *resources* (not just tool results) so
  hosts can surface them in their UI. Deferred rather than planned: these are the
  attach/@-mention picker, a user-initiated surface, not a citation path, and call
  volume does not yet justify it. The wiring is nearly free — `loadIndex()` already
  yields title/description/section/url and `getDoc` is the read callback.
- **Prompts** — ship an "author an @imqueue service" prompt template. Same reasoning.
- **Protocol revision** — the current revision is 2026-07-28; the SDK's
  `LATEST_PROTOCOL_VERSION` is behind that and this server cannot speak it. Do **not**
  hand-roll `server/discover` or `-32022`: the spec's own compatibility matrix says a
  non-modern 400 body is what makes a dual-era client fall back to `initialize` and
  connect, so emitting `-32022` would advertise modern support and suppress the
  recovery path. Track the SDK release that moves the constant, raise the `^1.12.0`
  floor then, and assert the negotiated version in a scheduled smoke run.

## 8. Licensing

GPL-3.0, matching the framework; commercial licensing via imqueue.com.
