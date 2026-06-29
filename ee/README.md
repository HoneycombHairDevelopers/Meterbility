# /ee — Enterprise Edition

This directory is reserved for Meterbility's commercial-source modules and is
licensed under the **Elastic License 2.0** (see [`LICENSE`](./LICENSE)).

Everything OUTSIDE this directory ships under MIT.

## Scope (what will live here)

Per the open-core boundary set at v0.3 launch:

- **Multi-tenant fleet orchestration** — running Meterbility as a hosted control
  plane across many customer agents with isolation guarantees.
- **SSO / RBAC / SCIM** — enterprise identity integration beyond
  `meter config user`.
- **Audit logs** — tamper-evident operator-action history beyond the local
  annotation table.
- **Long-retention modules** — storage tiers and lifecycle policies for
  multi-year trace corpora.

## What stays MIT (does NOT belong here)

The OSS core that powers single-operator, self-hosted Meterbility:

- The capture surfaces (`adapters/*`, `packages/agent`, `packages/agent-py`,
  `packages/proxy`)
- The trace format and replay engine (`packages/spec`, `packages/collector`,
  `packages/server`)
- The Inspector + Debugger UI (`packages/server` HTML/JSON routes,
  `packages/web`)
- The Live Probe SDK + CLI + web panel (Turn 8)
- The CLI (`packages/cli`)
- Postgres backend (`packages/store-postgres`) — multi-machine sync for a
  single operator stays in the OSS core; multi-tenant isolation goes /ee

## Status

**Empty today.** This directory is a forward-compatible marker so the
licensing boundary is visible in the repo *before* any /ee code lands. The
top-level [`LICENSE`](../LICENSE) explicitly notes the exception.

When the first /ee module lands, add it as a sibling subdirectory here
(e.g. `ee/sso/`, `ee/multi-tenant-controller/`) — never as a sibling of
`packages/` at the repo root.

## Why this split

Open core: MIT for everything a single operator on a single machine needs
to debug an agent fleet. ELv2 for the parts where "running this as a
hosted service for OTHER people's agents" is the value, because that's the
commercial product we don't want a third party to repackage and resell.

If you're contributing and unsure which side a feature belongs on, ask in
the PR. Default to MIT — moving code from /ee to MIT is easy; moving the
other direction breaks history.
