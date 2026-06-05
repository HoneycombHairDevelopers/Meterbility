# Security Policy

## Reporting a vulnerability

**Email:** security@honeycombhair.co

**Please do not** open a public GitHub issue, discussion, or PR for an
exploitable security bug. Email first; we'll acknowledge within 2
business days and coordinate a fix.

If you don't get an acknowledgement within 5 business days, follow up
on the same thread or open a private security advisory through
GitHub's "Report a vulnerability" button in the **Security** tab of
the repo.

### What to include

The more of this you can supply, the faster we can fix it:

- Spool version (output of `./bin/spool --version` and the commit SHA).
- Affected component (`packages/<name>`, `adapters/<name>`, or a CLI
  command).
- Minimum-viable reproduction — ideally a shell session or a tiny
  script.
- The impact (data exposure, RCE, privilege escalation, denial of
  service, etc.).
- Your assessment of severity (CVSS if you have it, or rough class).
- Whether you've shared the bug with anyone else.

You don't need a working exploit — a clear theoretical description is
enough to start the triage clock.

### What we'll do

1. **Acknowledge** within 2 business days.
2. **Triage** within 5 business days — confirm scope and severity, ask
   for clarification if needed.
3. **Fix** on a private branch. For critical bugs we cut a patch
   release; for lower severity we land in the next regular release.
4. **Coordinate disclosure** — we prefer to publish the advisory + fix
   at the same time. We'll work with you on a disclosure window
   (default 90 days, faster for trivial fixes).
5. **Credit you** in the advisory unless you ask us not to.

### Safe harbor

We won't pursue legal action against good-faith security research that:

- Doesn't violate user privacy or destroy user data.
- Doesn't exfiltrate user data beyond the minimum needed to demonstrate
  the bug.
- Stops at proof of concept — no production exploitation, no lateral
  movement on infrastructure you don't own.
- Reports privately first and gives us a reasonable disclosure window.

---

## Scope

### In scope

- Anything in this repository: the OSS core (MIT) under `packages/`,
  `adapters/`, `scripts/`, `bin/`; the ELv2 modules under `ee/` (when
  present); the docs.
- Distributed artifacts published from this repo (npm `@spool/*`
  packages when we publish, the `spool-agent` PyPI package).
- The reference Spool web server when run locally per the documented
  install instructions.

### Out of scope

- Vulnerabilities in dependencies — please report those to the
  upstream project. (We monitor advisories via the license audit + a
  forthcoming Dependabot setup and will pick up patches as they
  release.)
- Hosted Spool cloud — separate disclosure surface, separate contact.
  When the hosted service launches, this section will name it.
- Social engineering of maintainers.
- Issues in third-party clones of the codebase.
- Best-practice findings without a concrete attack chain (e.g. "you
  should use stricter Content Security Policy headers" — please open
  a public issue or PR for these).

---

## Threat model (what we assume vs. what we defend)

Spool is **local-first by default**. The web server binds to
`127.0.0.1` and has no authentication; the SQLite store and probe
files live under `$SPOOL_HOME` (default `~/.spool`) with the user's
own filesystem permissions.

**We assume:**

- The user trusts every process on their machine that can read
  `$SPOOL_HOME`.
- The user does not expose `spool web` on a public interface without
  adding their own auth layer (a reverse proxy, an SSH tunnel, a VPN).
- The Claude Code / Codex / Cursor session files Spool reads from were
  produced by trusted clients.

**We defend against:**

- **Secrets in captured content.** The redaction pipeline strips
  Anthropic / OpenAI API keys, AWS keys, generic high-entropy tokens,
  and a configurable allowlist of paths from blob contents before
  they hit the blob store. See `packages/shared/src/redact.ts` and
  `docs/architecture.md` for the rules.
- **Path traversal via untrusted run ids.** The Live Probe protocol
  URL-encodes run ids before using them as filenames (see
  `packages/shared/src/probe.ts` `probeFilePath`). A run id of
  `../../escape` lands at `probe/%2F..%2Fescape.json`, not outside
  `$SPOOL_HOME`.
- **SQL injection.** All queries use prepared statements
  (`better-sqlite3`, `pg`). Identifier-only paths (table/column names)
  are not interpolated from user input.
- **Cross-user data leakage in the optional Postgres backend.** The
  Postgres path is single-tenant by design today; multi-tenant
  isolation belongs in `/ee` when those modules ship.
- **Blob-store fill-and-overwrite.** Blob refs are content-addressed
  (SHA-256), so identical content dedupes. An attacker writing a
  malicious payload at a SHA that matches an existing blob would have
  to break SHA-256.

**We do NOT defend against:**

- An adversary with read access to `$SPOOL_HOME` — they have your
  entire trace history including any unredacted content blobs.
- An adversary who can connect to `127.0.0.1:4317` — the web UI is
  unauthenticated. Lock down your loopback or run behind auth.
- An adversary who can modify the session JSONL files we read from —
  they can inject arbitrary content into the ingested trace.

---

## Known-good handling of common reports

If you're considering reporting one of these, here's what's already
known and where the documentation lives:

- **"The web UI has no auth"** — by design, local-first. Not a vuln.
  Document recommendation: behind an SSH tunnel or reverse proxy.
- **"`$SPOOL_HOME` is world-readable on default macOS"** — file
  permissions inherit from the user's umask. We don't `chmod` the
  directory; if your environment requires it, set `umask 077` before
  the first `spool` invocation.
- **"Probe files persist after a crash"** — known. `tracer.end()`
  cleans up; an SDK crash before `end()` leaves a probe file behind.
  Use `spool probe clear <run-id>` for stale recovery.

Anything else, please report.

---

## Public advisories

When we publish a security advisory, it goes here as a link:

*(none yet — repo is pre-launch)*

---

## Acknowledgements

*(none yet — be the first!)*
