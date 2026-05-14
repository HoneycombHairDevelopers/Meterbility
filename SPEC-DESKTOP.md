# Spool Desktop — Product Specification

> **Working title.** "Spool Desktop." If the parent product renames, this renames in sympathy.
>
> **Status.** Pre-build. Drafted after the web UI shipped and the CLI stabilized at 47 tests / 12 commands. Companion to [SPEC.md](SPEC.md); reuses its data plane (SQLite + content-addressed blob store + trace format v0.2) verbatim.
>
> **Author.** Brantley. Drafted May 2026.

---

## 1. One-Line Product

**Spool Desktop is a native menu-bar companion that captures, alerts on, and inspects AI agent runs without a browser tab.**

The web UI was a server — start it, find the localhost link, click through tabs. Desktop is **always-on**: capture runs in the background, alert you via the OS notification surface, surface the fleet in a menu-bar status item, and open inspection in a real window that lives in `Cmd+Tab`.

The five-second pitch: *Spool, but it earns its dock icon.*

---

## 2. The Problem Desktop Solves

The web UI works. But:

1. **A localhost server is a friction tax.** "Did I `spool web` today?" "What port was it on?" "Did it crash overnight?" Spool is most valuable when it's always running, and a backgrounded `npm` process isn't always running in the way users mean.
2. **Browser tabs are where context goes to die.** A fleet operator running 10 agents already has 30 tabs open. Spool buried among them is Spool ignored.
3. **`spool web --live` notifications are stdout-only.** Alerts the operator sees only if they remember to look at the terminal. macOS users expect Notification Center; ignoring that is leaving signal on the table.
4. **Secrets live in env vars.** `ANTHROPIC_API_KEY`, Slack webhooks — all currently shell-environment. A desktop app gets Keychain integration for free, which most users expect once an app earns dock-icon status.

The bet: **the operator's threshold for "tool I check daily" is much higher than "tool I trigger from a terminal."** Desktop crosses that threshold.

---

## 3. Product Vision

A small native application that wraps the existing Spool data plane in three new surfaces:

### 3.1 Menu bar / status item

A tiny icon in the system menu bar (macOS) or system tray (Windows/Linux). Represents the current state of Spool's capture watcher:

```
●  watching · 3 active agents       (mint dot)
●  alert: agent #7 looping          (coral dot, gentle pulse)
○  idle · no agents detected        (tertiary dot)
✕  capture error (click to view)    (red ring, persistent)
```

Click → quick menu: "Open Fleet," "Open last run," "Pause watching," "Settings…," "Quit."

### 3.2 Main window

Same content as `spool web` — Fleet / Runs / Tests / Run detail / Diff / Context / Tests. The Cerulean styling ports directly. The host happens to be a native window with native chrome, but the body is the existing HTML.

What's *different* from the web in this window:
- Native scrollbars (or styled-to-match-system, not the muted-grey web ones)
- Real macOS title bar with traffic lights
- Window state restoration across launches (`Cmd+W` closes; `Cmd+N` opens fresh)
- Tabs (Safari-style) — multiple runs open at once

### 3.3 Floating inspector

A small borderless window that pins above your code editor. Use case: tune a prompt in Cursor or Claude Code, watch new runs pop into the inspector live without window-juggling.

Toggle from the menu bar item. Resizable. Translucent backdrop matching macOS's vibrancy effects.

---

## 4. Target Users

The same fleet operator from SPEC §5.1, with one tighter qualifier: **users who have already stopped opening `localhost:4317` as a habit.**

These are people who:
- Treat `iTerm2` as primary workspace
- Have 5+ Cursor windows open simultaneously
- Use Linear, Notion, Slack as dock-pinned apps, not browser tabs
- Already pay for Cursor / Raycast / Things — comfortable with $20/mo for a polished tool

Secondary: agent platform teams (SPEC §5.2). Multiple operators on the same team want a "Spool button" in their menu bar that always reflects production agent health.

---

## 5. Information Architecture

### 5.1 Windows

| Window | Purpose | Sizing |
|---|---|---|
| **Main** | Fleet / Runs / Tests / Run detail / Diff. Tabbed. | 1200×800 default, restores on relaunch |
| **Inspector (floating)** | One run pinned above other apps | 420×700, always-on-top toggle |
| **Settings** | Preferences pane | 720×500, modal-style |
| **Onboarding** | First-launch wizard | 600×400, one-shot |
| **About** | Version, credits, "open SPOOL_HOME in Finder" | 360×280 |

### 5.2 Native menus

Standard macOS menu bar:

- **Spool**: About · Preferences (⌘,) · Quit
- **File**: New Window (⌘N) · Open Run… (⌘O) · Export Trace… (⌘E) · Open SPOOL_HOME in Finder
- **Edit**: Standard Cmd+X/C/V + Find (⌘F)
- **Run**: Pause Watching · Resume · Ingest Now (⌘I) · Open in CLI (⌘T)
- **View**: Show Fleet · Show Runs · Show Tests · Toggle Floating Inspector
- **Window**: Standard Minimize/Close + tab navigation
- **Help**: Spool Docs · Open Trace Format Spec · Report Issue

### 5.3 Global keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘N` | New window (opens Fleet) |
| `⌘T` | New tab inside current window |
| `⌘O` | Open run by ID (Quick-open style) |
| `⌘K` | Command palette |
| `⌘F` | Find within current page |
| `⌘,` | Preferences |
| `⌘⇧F` | Toggle floating inspector |
| `j`/`k`/`g`/`G`/`?`/`/` | (inside a run) — same as web |

### 5.4 Cmd+K command palette

Single-input command launcher (à la Linear, Raycast):

```
> open run buy-side
  Build buy-side LMM deal workflow SaaS · run_83004589 · 98 steps · $68.84

> fork at step 12
  (after a run is open)

> create test from this run
> diff this with…
> show context for current step
> toggle floating inspector
> pause watching
```

Fuzzy-matches commands + run titles + step ids + test names.

---

## 6. Background Daemon

The main app runs a watcher daemon that persists even when no window is visible. Closing the last window does **not** quit the app — the menu bar item stays alive.

### 6.1 What the daemon does

- Watches `~/.claude/projects/` via `fs.watch` (FSEvents on macOS, `inotify` on Linux, `ReadDirectoryChangesW` on Windows) — replaces the current 1500ms polling
- Runs `LiveInspector` from the existing `@spool/server` package
- Fires native OS notifications for alerts (loop / stall / context-threshold / tool-watched)
- Routes notifications to Slack if configured
- Tracks SPOOL_HOME health (disk space, file integrity)
- Updates menu bar icon state in real-time

### 6.2 Lifecycle

| State | Trigger | UI |
|---|---|---|
| **Idle** | No agents detected | Grey dot |
| **Watching** | At least one Claude Code session log seen | Mint dot |
| **Active alert** | An alert event fired in last 5 min | Coral dot, pulse |
| **Error** | Capture failed (e.g. permission denied on `~/.claude/`) | Red ring, persistent |
| **Paused** | User clicked "Pause watching" | Hollow circle |

### 6.3 Launch at login

Opt-in toggle in Settings. Defaults **off** for the first install (don't surprise users). On macOS uses `SMAppService` (modern replacement for `LaunchAgents`).

---

## 7. Native OS Notifications

### 7.1 macOS

`UNUserNotificationCenter` with the following templates:

| Alert kind | Title | Body | Action |
|---|---|---|---|
| `loop` | Agent looping | "4× Bash with same args in `<run-title>`" | "Open run" (jumps to step) |
| `stall` | Run stalled | "No activity in `<title>` for `<X>` seconds" | "Open run" |
| `context_threshold` | Context filling up | "`<title>` reached `<N>%` of window" | "Open run" |
| `tool_called` | Watched tool fired | "`<title>` called `<tool>`" | "Open step" |
| `run_completed` | Run finished | "`<title>` completed (`<status>`) — `<X>` steps · $`<cost>`" | "Open run" |

User configures which kinds to surface in Settings. Default: all alerts on, run-completed off.

### 7.2 Sound

Default off. Configurable per-kind. macOS users famously hate notification sounds; we respect that.

### 7.3 Do-not-disturb

Honor macOS Focus modes (`UNFocusStatusCenter`). If the user is in a Focus, only `error` and `loop` alerts surface.

### 7.4 Windows / Linux

Toast Notifications API (Windows) / libnotify (Linux) — same alert kinds, same action behavior, OS-styled.

---

## 8. Secrets Storage

All sensitive values move from environment variables → OS keychain.

| Secret | macOS | Windows | Linux |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Keychain Services | Credential Manager | Secret Service / libsecret |
| Slack webhook URL | same | same | same |
| Future: GitHub PAT | same | same | same |
| Future: Postgres connection URL | same | same | same |

Settings UI shows a stub: `sk-ant-…████` with a "replace" button. Plaintext is never displayed; values can only be replaced, not read back. Anthropic SDK calls fetch the key at request-time, never log it.

The existing redaction pass (SPOOL_REDACT-respecting regex) continues to scrub keys from captured blobs — secrets storage is independent of capture-time redaction.

---

## 9. Settings / Preferences

Native preferences window with 5 tabs:

### Capture
- Runtimes to watch (Claude Code · Codex CLI · Cursor — each toggleable)
- Override paths (advanced)
- Redaction: **On** (regex-only) · Off · Custom rules
- SPOOL_HOME: shown read-only with "Open in Finder" button
- Retention: keep blobs for N days (default ∞)

### Notifications
- Alert kinds (per-kind toggle): loop / stall / context-threshold / tool-watched / run-completed / capture-error
- Stall threshold seconds (default 120, max 3600)
- Context thresholds (default 50/70/90, comma-separated)
- Watched tools (comma-separated list of tool names)
- Sound: per-kind dropdown (default None for all)
- Honor Focus modes (default On, macOS only)

### Integrations
- Slack webhook URL (stored in Keychain) + "Send test" button
- Anthropic API key (stored in Keychain) — needed for `--live` fork suffix
- Future: GitHub, Linear, Discord

### Appearance
- Theme: Dark (default) · Light · Auto (matches system)
- Font size: 13 / 14 (default) / 15 / 16
- Compact mode (smaller padding throughout)

### Advanced
- Polling fallback interval (when `fs.watch` unavailable)
- Debug logging (writes to `~/.spool/desktop.log`)
- "Reset to defaults" button

---

## 10. Multi-window UX

### 10.1 Tabs

Inside the main window, runs open as tabs (like Safari). `Cmd+T` opens a new tab on the Fleet. `Cmd+W` closes current tab. `Cmd+1`–`Cmd+9` jumps to tab N.

### 10.2 Tear-off

Drag a tab off the tab bar → spawns a new window with just that tab. Inverse drags the tab back. Matches Cursor / Chrome behavior.

### 10.3 Floating inspector

Toggle (`Cmd+Shift+F`) opens a small, always-on-top window showing the currently-watched run. When you change runs in the main window, the floating inspector follows.

### 10.4 Multiple monitors

Window state per-monitor. If you move the main window to a second monitor, then close it, relaunching restores to that monitor.

---

## 11. Tech Stack Recommendation

Two viable choices, each with tradeoffs:

### 11.1 Tauri (recommended)

- **Pros**: 5–10MB bundle (vs Electron's 100MB+); Rust core matches Spool's infra-tool aesthetic; system webview means OS-native scrolling, fonts, accessibility; smaller attack surface
- **Cons**: System webview means Safari quirks on macOS (some CSS, some web APIs differ); smaller ecosystem; Rust learning curve for some integrations
- **Bundle size matters here** — Spool's positioning is "lean infra," not "another Electron monstrosity"

### 11.2 Electron

- **Pros**: Reuses every line of `packages/server/src/html.ts` verbatim; mature ecosystem; auto-updater (`electron-updater`) is solved; familiar territory
- **Cons**: 100+ MB bundle; Chromium memory footprint; "yet another Electron app" is now a negative review trope
- **When to pick Electron**: if you want to ship in 2 weeks instead of 6

### 11.3 Recommendation

**Tauri 2.x.** The web UI uses standard HTML/CSS/JS that ports to any webview. The Rust backend handles the daemon (fs.watch, Keychain access, notifications) cleanly. Final bundle should target <15MB.

Frontend stays as-is from the existing `packages/server/src/html.ts` — Tauri serves it from a bundled asset directory or proxies to the same Hono app running on a local Unix socket.

### 11.4 What stays the same

- The SQLite store at `~/.spool/spool.db`
- The blob store at `~/.spool/blobs/`
- The trace format v0.2
- The Claude Code / Codex / Cursor adapters
- The CLI continues to work alongside Desktop (shared store)

### 11.5 What moves to Rust

- `LiveInspector` (better `fs.watch` integration)
- Keychain access
- Native notification API bindings
- Menu bar / system tray
- Auto-update plumbing

Everything else stays TypeScript and reuses the existing packages.

---

## 12. Packaging & Distribution

### 12.1 macOS

- Built via `tauri bundle --target universal-apple-darwin`
- Signed with Apple Developer ID Application certificate
- Notarized via `xcrun notarytool`
- Distributed as a `.dmg` containing the `.app`
- Auto-update via Sparkle (Tauri's `tauri-plugin-updater` wraps it)

### 12.2 Windows

- `.msi` installer signed with code-signing cert (Sectigo / DigiCert)
- Auto-update via NSIS wrapper or Squirrel.Windows
- Defaults to per-user install (no admin required)

### 12.3 Linux

- AppImage (universal, no install needed)
- `.deb` for Debian/Ubuntu derivatives
- `.rpm` for Fedora/RHEL
- `.tar.gz` for everything else
- Flatpak as future stretch

### 12.4 Update channels

- **Stable** (default) — once-a-month releases
- **Beta** — opt-in, bi-weekly
- **Nightly** — opt-in via env var, every commit

Channel switching from Settings → Advanced.

---

## 13. v0 Desktop Scope (Weeks 1–6)

macOS-only. Wraps the existing web UI in a Tauri shell. Adds the minimum amount of native sugar to justify being an app.

**Ships:**

- macOS `.app` bundle, signed + notarized
- Tauri 2.x shell hosting the existing web UI verbatim
- Menu bar status item with 5 states (idle / watching / alert / error / paused)
- Background daemon running `LiveInspector` (still polling — `fs.watch` lands in v0.1)
- Native macOS notifications for loop / stall / context-threshold / tool-watched
- Settings window with 4 tabs (Capture / Notifications / Integrations / Appearance)
- Keychain storage for `ANTHROPIC_API_KEY` and Slack webhook
- `Cmd+,` opens settings; `Cmd+N` opens fleet; `Cmd+Q` quits
- Onboarding wizard: 3 screens explaining capture / inspect / fork
- Auto-update via Sparkle on the **stable** channel only

**Does NOT ship in v0:**

- Windows or Linux builds
- `fs.watch` (still polls every 1.5s)
- Floating inspector window
- Tabs / multi-window
- Cmd+K command palette
- Tear-off windows
- Beta / nightly update channels
- Honor of Focus modes
- Custom redaction rules in UI
- Light mode (dark-only at launch)

### v0 success criteria

- Founder dogfoods on macOS for 14 days without falling back to `spool web`
- ≥3 of the v0.2 cohort named in SPEC §17.1 install it and don't uninstall within 7 days
- One unprompted positive comment ("I just leave this open now")
- Crash rate < 0.1% per launch (measured via Sentry)
- Cold-launch under 1.5 seconds (compared to ~2.5s for an equivalent Electron app)

---

## 14. v0.1 Desktop Scope (Weeks 7–10)

- Windows port (signed `.msi`)
- `fs.watch`-based capture (no more polling) — saves significant CPU when idle
- Multi-window tabs + tear-off
- Floating inspector (`Cmd+Shift+F`)
- Cmd+K command palette
- Beta update channel
- Honor of macOS Focus modes
- Light mode + theme switching

---

## 15. v0.2 Desktop Scope (Weeks 11–16)

- Linux builds (AppImage + .deb + .rpm)
- Auto-detect new agent runtimes (no more `spool ingest` — just open Claude Code and the daemon picks it up)
- "Open in CLI" — sends current run/step context to a terminal via deeplink
- Team mode: connect to the optional Postgres backend (SPEC §15.3), real-time fleet view across multiple operators
- iCloud Drive / Dropbox sync of SPOOL_HOME (opt-in, end-to-end encrypted)

---

## 16. Migration Story

The desktop app inherits everything from a CLI/web install:

- Reads `~/.spool/spool.db` directly — no schema migration
- Continues writing to the same blob store
- `spool` CLI keeps working alongside Desktop (they share the store via SQLite WAL)
- If a user runs `spool web` and Desktop is also running, both serve the same data — but they share a port lock, so the second one fails fast with a clear "Desktop is already running" message

Uninstalling Desktop leaves the data untouched — the web UI still works against the same `~/.spool/`.

---

## 17. Failure Modes

### 17.1 The bundle bloats to Electron-size
**Mitigation**: hard size budget. Block the release if `du -sh Spool.app` exceeds 25MB. Tauri makes this achievable; Electron would not.

### 17.2 Notification fatigue
**Mitigation**: defaults are conservative — only loop and stall alerts on by default. Onboarding makes the configurability clear. A "Quiet for 1 hour" menu item handles the obvious "I'm in flow" case.

### 17.3 Keychain integration breaks on locked machines
**Mitigation**: graceful degrade — if Keychain unlock fails (machine just woken from sleep), show a "Re-authenticate" prompt instead of crashing. Don't cache decrypted values in process memory longer than needed.

### 17.4 Auto-updater bricks installs
**Mitigation**: every update is signed and verified. Beta channel exists so a bad update only affects opt-ins. Rollback mechanism: keep the previous `.app` in `~/Library/Application Support/Spool/previous/` for one version, restore-via-menu-item if the user reports a broken update.

### 17.5 Background daemon eats battery
**Mitigation**: pause active watching when on battery + low power mode. Show "Battery saver active" in the menu bar status. Bench target: < 1% CPU averaged over 5 minutes when idle.

### 17.6 macOS sandbox / TCC denies access to `~/.claude/`
**Mitigation**: detect on first launch (`fs.access` test). If denied, surface a clear modal: "Spool needs access to your Claude Code logs. Click here to grant it in System Settings → Privacy & Security → Full Disk Access." Don't crash; degrade to read-only of `~/.spool/`.

---

## 18. Pricing for Desktop

Same tiers as SPEC §15, with Desktop included in:

- **Individual ($20/mo)**: Desktop access included. App is the primary UI.
- **Team ($50/seat/mo)**: Desktop with team-mode (connect to hosted Postgres backend).
- **Enterprise (custom)**: On-prem deployment + Desktop with VPN-style hosted backend.

The Desktop app itself is **free to download**, gated behind a license key at launch (or 14-day trial). Anonymous usage (no team-mode, no hosted features) is permanently free — the local-only Spool experience never costs anything.

---

## 19. Open Questions

1. **License gating UX.** First launch shows "Continue as guest (local-only) / Sign in to unlock Team features." Is this enough friction, or too much? Match Cursor (account on first launch) or Raycast (free locally, account for sync)?
2. **Crash reporting.** Sentry by default? Or fully opt-in to match the privacy stance from SPEC §10.5?
3. **Onboarding length.** 3 screens (current proposal) or single-screen "everything works, here's the menu bar"?
4. **Built-in agent runtime.** Should the Desktop app eventually include a "Try it" button that runs a Claude agent inside the app? Brings users without an existing Claude Code install onboard. Defer to v0.3+.
5. **Auto-update opt-out.** macOS users expect auto-update by default; some power users want manual control. Match Sparkle's standard "Update automatically" checkbox in Settings.

---

## 20. Strategic Position Summary

- **vs. just running `spool web`**: removes the localhost-server tax. Earns dock-icon status.
- **vs. Cursor's Agents window**: cross-runtime (not Cursor-only), and Spool's primitive (fork-and-replay) is structurally different from Cursor's "open this past chat" feature.
- **vs. Claude Code itself**: Spool is the post-hoc inspector that Claude Code lacks. Anthropic could build this; they haven't, and the cross-vendor positioning means it's not a single-rug-pull risk.
- **vs. native Datadog / Honeycomb desktop apps**: those don't exist. The competitor is "the terminal where you ran `spool web`" — which Spool Desktop replaces.

---

## 21. The Honest Decision Memo

Before Week 1 of Desktop builds, the founder commits to:

**Path A**: Desktop is the next big push. Web UI continues to receive critical fixes only. CLI continues. Team and Enterprise revenue stays the long-term play.

**Path B**: Don't build Desktop yet. Spend the same 6 weeks on the cold outreach from SPEC §17.1 + adapter polish (LangChain, Vercel AI SDK, Mastra). The web UI is already enough for the dogfood phase.

**Recommendation**: Path B until at least 3 of the §17.1 outreach replies and is willing to install + use Spool for 14 days. **Desktop is for users who already love the web UI** — building it before there's a base of those users is a polish move on top of an unvalidated product. The web UI in its current Cerulean form is already the right amount of polish for the validation phase.

The Desktop build is Path A only if validation has cleared. Otherwise it's premature optimization.

---

## 22. Implementation Quickstart (when Path A is chosen)

```bash
# Bootstrap
npm install --save-dev @tauri-apps/cli
npx tauri init

# Project structure
spool-desktop/
├── src-tauri/                  # Rust core
│   ├── src/
│   │   ├── main.rs             # tauri app entry
│   │   ├── daemon.rs           # LiveInspector port
│   │   ├── keychain.rs         # OS keychain bindings
│   │   ├── notifications.rs    # native notification API
│   │   └── menubar.rs          # status item
│   ├── tauri.conf.json
│   └── icons/                  # .icns, .ico, .png
├── src/                        # Web frontend (reuses html.ts output)
│   └── index.html              # bootstraps the Hono app
└── package.json
```

Key Tauri APIs:
- `tauri::menu::*` for the menu bar status item
- `tauri::tray::*` for system tray
- `keyring` crate for OS keychain
- `notify-rust` for cross-platform notifications
- `notify` crate for `fs.watch` equivalent

The first milestone: launch the existing Hono web app from inside the Tauri shell, point a `WebviewWindow` at it. That alone is ~50% of v0 done.

---

*End of spec.*
