# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in **@imqueue/mcp** (or any
`@imqueue/*` package), please report it **privately** — do not open a public issue,
pull request, or discussion for it.

Two private channels:

- **GitHub** — use *Security → Report a vulnerability* on this repository to open a
  private advisory (preferred; it keeps the report and the fix coordinated in one
  place).
- **Email** — <support@imqueue.com> with the details below.

Please include:

- the affected package and version(s);
- a description of the issue and its impact;
- steps to reproduce, or a proof of concept, where possible.

## What to expect

- We aim to acknowledge a report within a few business days.
- We'll confirm the issue, keep you updated on progress, and coordinate a fix and a
  disclosure timeline with you.
- Once a fix is released we'll credit the reporter in the advisory unless you prefer
  to remain anonymous.

## Supported versions

Security fixes land on the latest published release line of each `@imqueue/*`
package on npm. Please make sure you can reproduce an issue against the current
release before reporting.

## Note on this server

`@imqueue/mcp` ships in two forms, with deliberately different reach.

**Local (`npx -y @imqueue/mcp`, stdio).** Runs on your machine under your user
account. It fetches `imqueue.org` for documentation and nothing else — every
outbound URL is checked against that host before the request is made. The
CLI-backed tools (`create_service`, `generate_client`, `cli_install`, `fleet`,
`config`, `logs`) shell out to the `imq` binary and therefore act on your files,
your processes and your CLI configuration. `create_service` is a dry run unless
you pass `apply: true`. The server itself collects no telemetry and phones home
nowhere.

**Hosted (`https://mcp.imqueue.org/mcp`).** A Cloudflare Worker serving six
**read-only** tools: `search_docs`, `get_doc`, `list_packages`,
`scaffold_service`, `scaffold_client` and `local_install_guide`. The CLI-backed
tools are not registered on it — a hosted server cannot reach your machine, so it
does not advertise tools that would act on one. There are no accounts, no
authentication and no persistence: each request builds a fresh, stateless server
and the only data it handles is the arguments you send (a search query, a doc URL,
a service name). Cloudflare records Worker invocation logs for the endpoint, which
is disclosed in the [privacy policy](https://imqueue.org/privacy/); the server
adds no analytics or tracking of its own.

See the [safety model](https://imqueue.org/mcp/security/) for the full trust
boundary.

## Scope

The `@imqueue` framework is open source under GPL-3.0. This policy covers the code
in the `@imqueue/*` packages. Vulnerabilities in third-party dependencies should be
reported to those projects, though we're glad to help coordinate an upgrade.
