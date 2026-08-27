# Publishing to npm

All twelve workspace packages publish under the `@meterbility` scope. The CLI
installs the `meter` binary (from `@meterbility/cli`).

## One-time setup

1. Create the **meterbility** org on npmjs.com (Add Organization → free/public).
2. Auth is npm **trusted publishing** (OIDC) — no `NPM_TOKEN` secret. Register
   each `@meterbility/*` package's trusted publisher on npmjs.com
   (Package → Settings → Trusted Publisher): repository
   `HoneycombHairDevelopers/Meterbility`, workflow `publish.yml`, no
   environment.
3. OIDC cannot *create* a package: a brand-new package's first publish must be
   done once with user auth (`npm publish` from a logged-in machine), then the
   workflow owns it from the next release — see step 4 under
   [Adding a new workspace package](#adding-a-new-workspace-package).

## Publishing a release

The [publish workflow](../.github/workflows/publish.yml) runs automatically
when a GitHub release is published (or manually from the Actions tab). It
installs, builds, runs the full test suite, then publishes every package in
dependency order with npm provenance.

The run is safe to re-dispatch. A package version already on the registry is
skipped, so a run that dies mid-loop (registry outage, first-publish 404)
finishes the remainder on the next dispatch from the Actions tab. The loop
fails loudly instead of guessing: an ambiguous registry answer (outage, auth,
DNS) stops the run, and it refuses to publish at all if a workspace's version
has drifted from the root `package.json` version or the root version is
malformed. Concurrent runs queue rather than cancel, so a release trigger and
a manual re-dispatch can never interleave mid-publish.

To publish by hand instead:

```bash
npm login                     # must be a member of the meterbility org
npm run build
npm test
for w in packages/shared packages/spec packages/collector \
         packages/store-postgres adapters/claude-code adapters/codex-cli \
         adapters/cursor adapters/github-copilot packages/agent \
         packages/proxy packages/server packages/cli; do
  npm publish -w "$w" --access public
done
```

## Version bumps

Package versions are kept in lockstep with the repo version (the root
`VERSION` file).
When cutting a new release, bump `version` in every workspace `package.json`
(the CLI reads its version from its own `package.json` at runtime — there is
no separate string to edit), tag, and publish. Inter-package caret ranges
only need touching on a major bump.

## Local verification (what CI's gate doesn't cover)

The strongest pre-publish check is installing the packed tarballs outside the
workspace, which catches undeclared dependencies that workspace hoisting hides:

```bash
mkdir -p /tmp/meter-pack && for w in ...same list...; do
  npm pack -w "$w" --pack-destination /tmp/meter-pack
done
# then npm-install the CLI tarball in a scratch dir using "overrides" to map
# every @meterbility/* name to its local tarball, and run `meter doctor`.
```

## Python SDK (PyPI)

The Python SDK publishes separately to PyPI as **`meterbility-agent`** via the
[publish-pypi workflow](../.github/workflows/publish-pypi.yml), which runs on
the same GitHub-release trigger (plus manual dispatch). Auth is PyPI
**trusted publishing** — no token secret. One-time setup on pypi.org:
Account → Publishing → "Add a new pending publisher" with project
`meterbility-agent`, owner `HoneycombHairDevelopers`, repository `Meterbility`, workflow
`publish-pypi.yml`, environment `pypi`. Also create a `pypi` environment in
the GitHub repo settings (Settings → Environments) — it can be empty; it just
scopes the OIDC claim.

Like the npm loop, the PyPI job is safe to re-dispatch after a partial
release (say PyPI published but npm failed): a version already fully on PyPI
(sdist and wheel both present) is skipped instead of failing on "version
already exists", a partial upload (one file landed, the other didn't) is
rebuilt and completed via `skip-existing`, and an ambiguous answer from PyPI
fails the job rather than guessing. Both publish workflows also queue
concurrent runs instead of cancelling them.

The distribution version lives in `packages/agent-py/pyproject.toml` and
`src/meterbility_agent/__init__.py` (`__version__`) — bump both in lockstep with
the npm packages.

## Adding a new workspace package

Registration points beyond the package directory itself — miss any and it
fails somewhere non-local:

1. **Root `tsconfig.json` `paths`** — maps `@meterbility/<name>` to
   `<dir>/src/index.ts`. This is how `tsx` resolves workspace imports from
   source in unbuilt checkouts; without it, fresh-laptop CI (which runs
   `npm install` → `npm test` with no build step) dies with
   `ERR_MODULE_NOT_FOUND` on `<pkg>/dist/index.js`. It never reproduces on a
   dev machine because local builds leave `dist/` behind — verify by deleting
   every adapter's `dist/` and running `./bin/meter --version`.
2. **Root `package.json` `build` script** — the `-w` list is ordered by
   dependency topology; insert the package after its dependencies.
3. **[publish.yml](../.github/workflows/publish.yml)** — the publish loop is a
   hard-coded ordered list, same topology.
4. **npmjs.com trusted publisher** — register the new package name with
   `publish.yml` as its trusted publisher before the next release, or its
   `npm publish` 404s.
5. The usual in-repo surfaces: version lockstep with the other manifests,
   `docs/architecture.md` package tree, README capability matrix.
