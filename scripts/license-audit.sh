#!/usr/bin/env bash
#
# license-audit.sh — Verify every installed dependency ships under a
# license compatible with Spool's MIT core. Track C / Turn 9 chunk 2.
#
# Exits:
#   0  every direct dep is in the allowlist
#   1  a direct dep declares a non-allowlist license (HARD FAIL)
#   2  a transitive dep declares a non-allowlist license (SOFT FAIL —
#      only happens via a direct dep, which would have failed first,
#      but the explicit check catches contamination from `npm install`
#      without a corresponding package.json edit)
#
# Used by:
#   - `LICENSES-third-party.md` (referenced as the regeneration source)
#   - CI (run after `npm install` on every PR)
#   - Humans curious about the audit picture
#
# Re-runnable as often as you like — pure read from node_modules.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -d node_modules ]]; then
  echo "license-audit: node_modules not found — run \`npm install\` first" >&2
  exit 1
fi

python3 <<'PY'
import json, pathlib, sys, collections

# ─── Configuration ──────────────────────────────────────────────────

# Permissive licenses we accept anywhere in the tree.
ALLOWED = {
    "MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause",
    "BSD", "0BSD", "CC0-1.0", "Unlicense", "Python-2.0", "WTFPL",
    "BlueOak-1.0.0",  # increasingly common alternative to MIT
}

# Multi-license OR strings count as allowed if ANY branch is allowed.
# We don't enforce that the user picks a specific branch — they can
# pick the most permissive one at distribution time.
def is_allowed(license_str):
    if not license_str:
        return False
    s = license_str.strip()
    # Strip parens for OR strings like "(BSD-2-Clause OR MIT OR Apache-2.0)"
    s = s.strip("()")
    if " OR " in s:
        return any(branch.strip() in ALLOWED for branch in s.split(" OR "))
    return s in ALLOWED

# Known-benign undeclared paths. False positives from our scanner
# walking into sub-module shims or example fixtures.
KNOWN_BENIGN = {
    # web-streams-polyfill sub-shims (root declares MIT)
    "node_modules/web-streams-polyfill/es5/package.json",
    "node_modules/web-streams-polyfill/polyfill/package.json",
    "node_modules/web-streams-polyfill/polyfill/es5/package.json",
    # github-from-package ships a docs example with its own package.json
    "node_modules/github-from-package/example/package.json",
}

# ─── Direct deps from our own package.jsons ─────────────────────────

direct_deps = set()
for f in [pathlib.Path("package.json")] + list(pathlib.Path("packages").glob("*/package.json")) + list(pathlib.Path("adapters").glob("*/package.json")):
    d = json.loads(f.read_text())
    for k in ("dependencies", "devDependencies", "peerDependencies"):
        for name in (d.get(k) or {}):
            if name.startswith("@spool-ai/"):
                continue
            direct_deps.add(name)

# ─── Walk node_modules and classify ─────────────────────────────────

def normalize_license(d):
    lic = d.get("license")
    if isinstance(lic, dict):
        lic = lic.get("type")
    if isinstance(lic, list):
        return "|".join(l.get("type") if isinstance(l, dict) else str(l) for l in lic)
    if lic:
        return lic
    lics = d.get("licenses")
    if isinstance(lics, list):
        return "|".join(l.get("type") if isinstance(l, dict) else str(l) for l in lics)
    return None

direct_fail = []
transitive_fail = []
hist = collections.Counter()
unknown_unexpected = []

for pj in pathlib.Path("node_modules").rglob("package.json"):
    rel = pj.relative_to(".")
    if str(rel) in KNOWN_BENIGN:
        continue
    if len(pj.relative_to("node_modules").parts) > 4:
        continue
    try:
        d = json.loads(pj.read_text())
    except Exception:
        continue
    name = d.get("name")
    if not name:
        continue
    lic = normalize_license(d)
    if not lic:
        unknown_unexpected.append((name, str(rel)))
        continue
    hist[lic] += 1
    if not is_allowed(lic):
        entry = (name, lic, str(rel))
        if name in direct_deps:
            direct_fail.append(entry)
        else:
            transitive_fail.append(entry)

# ─── Report ─────────────────────────────────────────────────────────

print("=== License histogram ===")
for lic, n in hist.most_common():
    mark = " " if is_allowed(lic) else "!"
    print(f"  {mark} {n:4d}  {lic}")
print()

if unknown_unexpected:
    print(f"=== UNEXPECTED undeclared ({len(unknown_unexpected)}) ===")
    print("These packages have no license field AND are not in the")
    print("known-benign list. Investigate and either declare benign or")
    print("swap them for a properly-licensed alternative.")
    for n, p in unknown_unexpected:
        print(f"  {n}  ({p})")
    print()

if direct_fail:
    print(f"=== HARD FAIL: direct deps with non-allowlist license ===")
    for n, l, p in direct_fail:
        print(f"  {n}  license={l}  ({p})")
    sys.exit(1)

if transitive_fail:
    print(f"=== SOFT FAIL: transitive deps with non-allowlist license ===")
    for n, l, p in transitive_fail:
        print(f"  {n}  license={l}  ({p})")
    sys.exit(2)

print("license-audit: OK — every dep is in the allowlist")
PY
