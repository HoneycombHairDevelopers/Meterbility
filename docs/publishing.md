# Publishing to npm

All eleven workspace packages publish under the `@spool-ai` scope (the bare
`spool` name and `@spool` scope were already taken on npm).

## One-time setup

1. Create the **spool-ai** org on npmjs.com (Add Organization → free/public).
2. Generate an **automation** token: npmjs.com → Access Tokens → Generate New
   Token → Automation. Automation tokens bypass 2FA so CI can publish.
3. Add it to the GitHub repo as the `NPM_TOKEN` secret:
   `gh secret set NPM_TOKEN --repo HoneycombHairDevelopers/Spool`

## Publishing a release

The [publish workflow](../.github/workflows/publish.yml) runs automatically
when a GitHub release is published (or manually from the Actions tab). It
installs, builds, runs the full test suite, then publishes every package in
dependency order with npm provenance.

To publish by hand instead:

```bash
npm login                     # must be a member of the spool-ai org
npm run build
npm test
for w in packages/shared packages/spec packages/collector \
         packages/store-postgres adapters/claude-code adapters/codex-cli \
         adapters/cursor packages/agent packages/proxy packages/server \
         packages/cli; do
  npm publish -w "$w" --access public
done
```

## Version bumps

Package versions are kept in lockstep with the repo version (`0.3.0`).
When cutting a new release, bump `version` in every workspace `package.json`
plus the CLI's `.version()` string in `packages/cli/src/index.ts`, tag, and
publish. Inter-package ranges (`^0.3.0`) only need touching on a major bump.

## Local verification (what CI's gate doesn't cover)

The strongest pre-publish check is installing the packed tarballs outside the
workspace, which catches undeclared dependencies that workspace hoisting hides:

```bash
mkdir -p /tmp/spool-pack && for w in ...same list...; do
  npm pack -w "$w" --pack-destination /tmp/spool-pack
done
# then npm-install the CLI tarball in a scratch dir using "overrides" to map
# every @spool-ai/* name to its local tarball, and run `spool doctor`.
```

The Python SDK (`packages/agent-py`) is published separately to PyPI as
`spool-agent` and is not part of this pipeline.
