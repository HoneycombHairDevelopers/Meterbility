# Cursor real-capture corpus

Each subdirectory is one redacted extract of a real Cursor `state.vscdb`
plus a pinned expectation, checked by `src/corpus.test.ts`:

```
<capture-name>/
  capture.json   # composerData, composerHeaders, bubbleId rows, checkpoints,
                 # fate ledgers, composer.content blobs — redacted
  expect.json    # drift report + {composers, steps, file_changes[]} pin
```

Fixture tests pin a shape someone typed; this pins what Cursor actually
wrote, so a Cursor upgrade that renames a tool, changes a status word, or
moves a content-id prefix shows up as a test diff instead of as silent
zero-line file_change rows.

## Adding a capture

1. Extract (the DB is opened read-only; pick composers that ran file tools):

   ```
   node --import tsx/esm adapters/cursor/scripts/extract-corpus.ts \
     --db "$HOME/Library/Application Support/Cursor/User/globalStorage/state.vscdb" \
     --out /tmp/corpus/<capture-name> \
     --composer <composerId> [--composer <composerId> ...] \
     --workspace <workspaceId>=file:///abs/workspace/folder
   ```

   Redaction applied: home dir → `/Users/dev`, user name → `dev`, emails →
   `user@example.com`, encryption keys / richText / conversationMap dropped,
   every string capped at 400 chars except file-tool params/results,
   checkpoints, fate ledgers and content blobs (the file-change derivation
   needs those intact).

2. Review `capture.json` by hand — it is data from a real session. Grep for
   your user name, emails and anything key-shaped; truncate a content blob if
   it is sensitive and say so in the capture's `notes`.

3. Generate and review the pin, then move both files here:

   ```
   METER_CURSOR_CORPUS_ROOT=/tmp/corpus UPDATE_CORPUS=1 \
     node --import tsx/esm --test adapters/cursor/src/corpus.test.ts
   mv /tmp/corpus/<capture-name> adapters/cursor/fixtures/corpus/
   ```

`UPDATE_CORPUS=1` regenerates `expect.json` after an intentional adapter
change; read the diff before committing it.
