<!--
Thanks for the PR. Please run through the checklist before requesting review.
For SECURITY fixes, please coordinate via SECURITY.md first — don't open
a public PR until we've agreed on disclosure timing.
-->

## What changed

<!-- One paragraph. Focus on what NEW capability or fix this PR delivers. -->

## Why

<!-- One paragraph. The motivation — the bug you saw, the workflow that broke,
     the user request, the spec section you're implementing. -->

## How verified

<!-- The test output, screenshots, smoke command, or manual sequence
     that proves this works. Be specific — "I ran `npm test`" is fine
     if that's the whole story; add detail for anything more involved. -->

```
# e.g.
npm test 2>&1 | tail -10
# tests 250 / pass 250 / fail 0
```

## Checklist

- [ ] Added or updated tests for the change
- [ ] `npm test` passes locally
- [ ] If Python SDK changed: `python3 -m unittest discover -s packages/agent-py/tests` passes
- [ ] If a new dependency: `./scripts/license-audit.sh` passes
- [ ] Updated relevant docs (README, CONTRIBUTING, SECURITY, or `docs/`)
- [ ] Updated `CHANGELOG.md` if there's a user-facing surface change
- [ ] Cleaned up any `/tmp` or `/var/folders` smoke artifacts

## License placement

<!-- Default MIT for everything outside ee/. Tick the second box only if
     this PR adds files under ee/ — those contributions ship under
     Elastic License 2.0 and you confirm you have the right to license
     them under ELv2. -->

- [ ] This PR is licensed under MIT (default — code lives outside `ee/`)
- [ ] This PR adds code under `ee/` and I acknowledge it ships under ELv2

## Related

<!-- Linked issues, related PRs, spec section, prior conversation. -->
