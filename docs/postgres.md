# Postgres backend (optional)

SPEC §15.3 — the team tier needs shared run history across multiple operators. Spool's local default stays SQLite; Postgres is a parallel deployment target you can opt into per-organization.

## Status: experimental in v0.1

What works:

- Schema provisioning (`spool db postgres-init`)
- One-way sync of local SQLite → Postgres (`spool db postgres-sync`)
- Read APIs (`pgListRuns`, `pgGetRun`, `pgListSteps`)
- Blob storage (inline `bytea` column rather than filesystem sharding)

What doesn't yet:

- The CLI surface (`list`, `inspect`, `fork`, `web`) still reads from SQLite. The Postgres backend is for *replication*, not yet for *primary writes*.
- Concurrent writers — sync is intended for one-way replication, not multi-master.

## Set up

```bash
# Point at any Postgres URL. Free tier of Neon, Supabase, Render works.
export SPOOL_DB_URL="postgres://user:pass@host:5432/spool"

spool db postgres-init
#   → connected  schema_version=2

spool db postgres-sync
#   → synced 12 runs · 487 steps · 1042 blobs (8.4MB) in 1820ms
```

Re-run `postgres-sync` whenever you want to push the latest local activity. It's idempotent (every insert uses `ON CONFLICT DO UPDATE`).

## Schema

See [`packages/store-postgres/src/schema.ts`](../packages/store-postgres/src/schema.ts). Mirrors the SQLite schema with type substitutions:

- `TEXT` for ids and labels (matches SQLite).
- `JSONB` for `tags`, `action`, `outcome`, `assertions`, `details` — queryable later via `jsonb_path_ops`.
- `TIMESTAMPTZ` instead of free-form text timestamps.
- `BYTEA` blob column (inline) — no filesystem dependency on the hosted side.

Schema version is stamped in the `meta` table; future migrations will bump and run accordingly.

## Why blobs are inline in Postgres mode

SQLite mode stores blobs on the filesystem (sharded by SHA prefix) because filesystem dedup beats SQLite's blob handling for that access pattern. Postgres mode inlines them in `bytea` because:

- The hosted use case is "share with teammates," and a network-attached filesystem alongside Postgres is operationally heavier than just letting Postgres handle bytes.
- `bytea` columns participate in normal Postgres backups.
- TOAST handles compression transparently.

If your runs are unusually large (hundreds of MB per run), point `blobs.content` at S3 by extending `PostgresStore.putBlob` — left as an integration option rather than a default.

## Roadmap

- v0.2 will let `spool web` read directly from Postgres via `--store postgres`.
- v0.2 will introduce the team tier (multi-user, RBAC) on top of Postgres.
- v0.2 will add `postgres-sync --watch` for continuous replication.

For now, treat the backend as the storage layer for a future hosted deployment, not as a daily-driver swap.
