# Meterbility Trace Format v0.1

The on-wire/on-disk format Meterbility emits via `meter export` and consumes via future ingest paths. Plain JSON, base64-inlined blobs, no native bindings required to read.

JSON Schema: [`packages/spec/schemas/trace-format.v0.1.json`](../packages/spec/schemas/trace-format.v0.1.json).

## Top-level shape

```json
{
  "meter_trace_version": "0.1.0",
  "run": { ... },
  "steps": [ ... ],
  "blobs": {
    "<sha256>": "<base64-encoded utf-8 content>"
  }
}
```

`blobs` is optional — pass `--no-blobs` to `meter export` for a refs-only file (suitable for diffing structure when content is huge).

## Entities

The full model is in [SPEC §6](../SPEC.md). The wire format is a flat projection:

- **Run** — one end-to-end agent execution.
- **Step** — one model invocation plus consequences. Carries `context_snapshot_id`, `decision_ref`, `action`, `outcome`, `tokens`, `cost_cents`, etc.
- **Action** — what the model decided to do (`tool_call`, `message`, `thinking_only`, `sub_agent_dispatch`, `none`).
- **Outcome** — what happened next (status + optional `tool_result_ref`).

## Content addressing

Every large blob — context snapshots, decision bytes, tool results — is referenced by SHA256. Two Steps that share the same context bytes share the same `context_snapshot_id`. The `blobs` map is the inlined dictionary.

The current storage layer keeps two related ids:

- `snapshot_id` — `sha256` of the canonicalized `components[]` array (stable across replay).
- `blob_ref` — `sha256` of the serialized snapshot JSON (where the bytes actually live).

These often differ. In trace-format documents the `blobs` map keys are always real blob hashes — readers verify the hash matches the bytes.

## Compatibility

- `0.1.x` is the v0 format.
- Backward-incompatible changes bump the minor version (`0.2.0`) and Meterbility will refuse to ingest the older format until a migration ships.
- Forward-compatible additions (new optional fields) keep the same version.

## Why not OpenLLMetry / OpenInference?

[SPEC §16.3](../SPEC.md) and §26 q10: open question. v0 ships a clean schema sized for the debugging workflow (forks, snapshots, outcomes); v0.2 considers either adopting the winning OpenInference dialect or proposing an extension. We deliberately don't yet emit OTel spans on the wire — Meterbility's value sits one layer above tracing.
