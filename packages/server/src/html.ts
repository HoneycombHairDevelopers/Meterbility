import type { Annotation, FileChange, FileOp, Run, Step } from "@spool/shared";
import type { DiffResult } from "./diff.ts";
import type { FleetEntry } from "./live.ts";
import type { RegressionResult, RegressionTest } from "./regression.ts";

/**
 * Server-rendered HTML. Single bundle of styles + tiny vanilla JS for
 * interactivity. v0 is deliberately framework-free — Spool's web UI
 * needs to feel like a DevTools panel, and a single-file render is
 * fastest to iterate on.
 */

const STYLES = `
  /* ─── Cerulean Design System tokens ─────────────────────────────── */
  :root {
    /* Brand */
    --cerulean-50:  #EBF7FC;
    --cerulean-100: #CFEAF6;
    --cerulean-200: #A5D9EE;
    --cerulean-300: #6FC1E1;
    --cerulean-400: #38BDF8;
    --cerulean-500: #00A6E0;
    --cerulean-600: #0284C0;
    --cerulean-700: #0369A1;
    --cerulean-800: #075985;
    --cerulean-900: #0C4A6E;

    /* Surfaces */
    --surface-0: #08090B;
    --surface-1: #0E1014;
    --surface-2: #161A21;
    --surface-3: #1F2630;
    --surface-4: #2A3340;
    --border-subtle: #1A1F2A;
    --border-default: #252D3A;
    --border-strong: #3A4655;

    /* Text */
    --text-primary: #E8ECEF;
    --text-secondary: #9AA5B5;
    --text-tertiary: #5F6B7C;
    --text-disabled: #3F4856;
    --text-on-accent: #04141E;

    /* Semantic */
    --amber-400: #FBBF24;
    --amber-bg: rgba(251,191,36,0.08);
    --coral-400: #F87171;
    --coral-bg: rgba(248,113,113,0.08);
    --mint-400:  #34D399;
    --mint-bg:   rgba(52,211,153,0.08);
    --violet-400:#A78BFA;
    --violet-bg: rgba(167,139,250,0.08);

    /* Type */
    --font-sans: "Geist", "Söhne", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    --font-mono: "Geist Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;

    /* Spacing */
    --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
    --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;
    --space-12: 48px; --space-16: 64px;

    /* Radius */
    --radius-xs: 2px; --radius-sm: 4px; --radius-md: 6px;
    --radius-lg: 8px; --radius-xl: 12px;

    /* Elevation */
    --elevation-0: 0 0 0 1px var(--border-default);
    --elevation-1: 0 0 0 1px var(--border-strong),
                   inset 0 1px 0 0 rgba(255,255,255,0.03);
    --elevation-2: 0 0 0 1px var(--border-strong),
                   0 20px 60px -20px rgba(0,0,0,0.8),
                   inset 0 1px 0 0 rgba(255,255,255,0.04);
    --focus-ring: 0 0 0 2px var(--surface-0),
                  0 0 0 4px var(--cerulean-400);
    --brand-glow: 0 0 80px -20px rgba(56,189,248,0.35);

    /* Motion */
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    --duration-fast: 120ms;
    --duration-default: 200ms;
    --duration-slow: 400ms;

    /* ─── Aliases for legacy class references ─── */
    --bg:        var(--surface-0);
    --bg-2:      var(--surface-1);
    --bg-3:      var(--surface-2);
    --border:    var(--border-default);
    --fg:        var(--text-primary);
    --fg-mute:   var(--text-secondary);
    --accent:    var(--cerulean-400);
    --ok:        var(--mint-400);
    --warn:      var(--amber-400);
    --err:       var(--coral-400);
    --fork:      var(--violet-400);
  }

  /* ─── Reset + base ──────────────────────────────────────────────── */
  * { box-sizing: border-box; }
  ::selection { background: rgba(56,189,248,0.25); color: var(--text-primary); }
  html, body {
    margin: 0; padding: 0;
    background: var(--surface-0); color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    font-feature-settings: "ss01", "cv11";
  }
  code, pre, .mono {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-feature-settings: normal;
  }

  /* ─── Links ─────────────────────────────────────────────────────── */
  a { color: var(--cerulean-400); text-decoration: none; transition: color var(--duration-fast) var(--ease-out); }
  a:hover { color: var(--cerulean-300); text-decoration: underline; text-underline-offset: 2px; }

  /* ─── Section labels (Modal-style) ──────────────────────────────── */
  .section-label {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--cerulean-400);
    margin-bottom: var(--space-2);
  }

  /* ─── Header ────────────────────────────────────────────────────── */
  header {
    position: sticky; top: 0; z-index: 30;
    height: 60px;
    padding: 0 var(--space-6);
    background: rgba(8, 9, 11, 0.78);
    backdrop-filter: blur(14px) saturate(180%);
    -webkit-backdrop-filter: blur(14px) saturate(180%);
    border-bottom: 1px solid var(--border-subtle);
    display: flex; align-items: center; gap: var(--space-6);
  }
  header .brand {
    display: inline-flex; align-items: center; gap: 10px;
    color: var(--text-primary);
    font-weight: 600; font-size: 15px; letter-spacing: -0.01em;
  }
  header .brand:hover { text-decoration: none; color: var(--text-primary); }
  header .brand-mark {
    width: 18px; height: 18px;
    border-radius: var(--radius-sm);
    background: linear-gradient(135deg, var(--cerulean-400) 0%, var(--cerulean-700) 100%);
    box-shadow: var(--brand-glow);
  }
  header .topnav { display: flex; gap: var(--space-5); font-size: 13px; }
  header .topnav a {
    color: var(--text-secondary);
    padding: 4px 0;
    transition: color var(--duration-fast) var(--ease-out);
  }
  header .topnav a:hover { color: var(--text-primary); text-decoration: none; }
  header .crumbs {
    color: var(--text-tertiary); font-size: 13px;
    font-family: var(--font-mono);
  }
  header #flash {
    margin-left: auto; font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    opacity: 0;
    transition: opacity var(--duration-fast) var(--ease-out);
  }
  header #flash[data-kind="err"]  { color: var(--coral-400); }
  header #flash[data-kind="info"] { color: var(--cerulean-400); }

  main {
    padding: var(--space-8) var(--space-6) var(--space-12);
    max-width: 1500px; margin: 0 auto;
  }

  h2 { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; margin: 0; }
  h3 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: -0.005em; }

  /* ─── Tables ────────────────────────────────────────────────────── */
  table {
    width: 100%;
    font-size: 13px;
    border-collapse: collapse;
  }
  th, td { text-align: left; vertical-align: middle; }
  th {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-default);
    background: var(--surface-0);
  }
  td {
    padding: var(--space-3) var(--space-4);
    color: var(--text-primary);
    border-bottom: 1px solid var(--border-subtle);
  }
  td.numeric, td.mono {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  tbody tr { transition: background var(--duration-fast) var(--ease-out); }

  /* ─── Scrollable table wrapper ──────────────────────────────────── */
  /* Wraps wide tables (Runs page) so they scroll horizontally instead
     of squeezing all 8 columns into the viewport. The table sets its
     own min-width to keep columns from collapsing when there's space. */
  .table-scroll {
    overflow-x: auto;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }
  .table-scroll::-webkit-scrollbar { height: 10px; }
  .table-scroll::-webkit-scrollbar-track { background: var(--surface-0); }
  .table-scroll::-webkit-scrollbar-thumb {
    background: var(--surface-3);
    border-radius: var(--radius-full);
    border: 2px solid var(--surface-0);
  }
  .table-scroll::-webkit-scrollbar-thumb:hover { background: var(--surface-4); }
  .runs-table { min-width: 1180px; }
  .runs-table td:first-child,
  .runs-table th:first-child {
    /* Title column gets the most breathing room and is allowed to wrap
       to one extra line on long titles — but stop at 480px so it
       doesn't push the rest of the table off-screen. */
    min-width: 320px; max-width: 480px;
    white-space: normal;
  }
  .runs-table td:last-child,
  .runs-table th:last-child {
    /* Project column — cap so deep nested paths don't dominate. */
    max-width: 240px;
    overflow: hidden; text-overflow: ellipsis;
  }
  tbody tr:hover { background: var(--surface-1); }

  /* ─── Badges (status pills) ─────────────────────────────────────── */
  .badge, .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: var(--radius-xs);
    border: 1px solid var(--border-default);
    background: var(--surface-2);
    color: var(--text-secondary);
    line-height: 1.5;
    white-space: nowrap;
  }
  .badge--info,
  .pill.in_progress, .pill.live-awaiting_input {
    color: var(--cerulean-300);
    background: rgba(56, 189, 248, 0.08);
    border-color: rgba(56, 189, 248, 0.25);
  }
  .badge--success,
  .pill.ok, .pill.live-progressing, .pill.live-completed {
    color: var(--mint-400);
    background: var(--mint-bg);
    border-color: rgba(52, 211, 153, 0.25);
  }
  .badge--warn,
  .pill.live-stalled {
    color: var(--amber-400);
    background: var(--amber-bg);
    border-color: rgba(251, 191, 36, 0.25);
  }
  .badge--error,
  .pill.error, .pill.live-errored, .pill.live-looping {
    color: var(--coral-400);
    background: var(--coral-bg);
    border-color: rgba(248, 113, 113, 0.25);
  }
  .badge--premium,
  .pill.fork {
    color: var(--violet-400);
    background: var(--violet-bg);
    border-color: rgba(167, 139, 250, 0.25);
  }
  .badge--muted,
  .pill.abandoned {
    color: var(--text-tertiary);
    background: var(--surface-2);
    border-color: var(--border-default);
  }

  /* Status dots */
  .dot {
    width: 6px; height: 6px; border-radius: var(--radius-full);
    display: inline-block;
    background: currentColor;
  }
  .dot--success { color: var(--mint-400); box-shadow: 0 0 6px rgba(52, 211, 153, 0.6); }
  .dot--error   { color: var(--coral-400); }
  .dot--warn    { color: var(--amber-400); }
  .dot--info    { color: var(--cerulean-400); box-shadow: 0 0 6px rgba(56, 189, 248, 0.5); }
  .dot--muted   { color: var(--text-tertiary); box-shadow: none; }

  /* ─── v0.3 Live toggle ────────────────────────────────────────────
     Sits in the header alongside the topnav. Two visual states drive
     off the data-live attribute: idle (muted, "GO LIVE") vs live
     (mint dot pulse, "LIVE"). Click hits POST /api/live/start|stop
     and the JS handler flips the attribute without a reload. */
  .live-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    height: 26px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-default);
    background: var(--surface-1);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.06em;
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-out),
                border-color var(--duration-fast) var(--ease-out),
                color var(--duration-fast) var(--ease-out);
  }
  .live-toggle:hover {
    background: var(--surface-2);
    border-color: var(--border-strong);
    color: var(--text-primary);
  }
  .live-toggle[data-live="1"] {
    border-color: var(--mint-400);
    color: var(--mint-400);
    background: rgba(52, 211, 153, 0.08);
  }
  .live-toggle[data-live="1"]:hover {
    background: rgba(52, 211, 153, 0.14);
  }
  .live-toggle[data-live="1"] .dot {
    animation: live-pulse 1.4s ease-in-out infinite;
  }
  .live-toggle[disabled] { opacity: 0.55; cursor: progress; }
  @keyframes live-pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 6px rgba(52, 211, 153, 0.6); }
    50%      { opacity: 0.55; box-shadow: 0 0 2px rgba(52, 211, 153, 0.3); }
  }

  /* Auto-dot for live-status pills inside fleet cards. Lives in the
     pseudo-element so we don't have to change every render call site. */
  .pill.live-progressing::before,
  .pill.live-stalled::before,
  .pill.live-looping::before,
  .pill.live-awaiting_input::before,
  .pill.live-errored::before,
  .pill.live-completed::before {
    content: ""; width: 6px; height: 6px; border-radius: var(--radius-full);
    background: currentColor; flex-shrink: 0;
  }
  .pill.live-progressing::before { box-shadow: 0 0 6px rgba(52,211,153,0.6); }
  .pill.live-awaiting_input::before { box-shadow: 0 0 6px rgba(56,189,248,0.5); }
  .pill.live-looping::before { box-shadow: 0 0 6px rgba(248,113,113,0.5); }

  /* ─── Buttons ───────────────────────────────────────────────────── */
  button {
    background: transparent;
    color: var(--text-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    padding: 8px 14px;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-out),
                border-color var(--duration-fast) var(--ease-out),
                color var(--duration-fast) var(--ease-out);
  }
  button:hover { background: var(--surface-2); border-color: var(--border-strong); }
  button:focus-visible { outline: none; box-shadow: var(--focus-ring); }
  button.primary {
    background: var(--cerulean-400);
    color: var(--text-on-accent);
    border-color: var(--cerulean-400);
    font-weight: 500;
  }
  button.primary:hover {
    background: var(--cerulean-300);
    border-color: var(--cerulean-300);
  }
  button.primary:active {
    background: var(--cerulean-500);
    border-color: var(--cerulean-500);
  }
  button.tertiary {
    background: transparent;
    border: 1px solid transparent;
    color: var(--cerulean-400);
    padding: 6px 8px;
  }
  button.tertiary:hover {
    background: rgba(56, 189, 248, 0.08);
    color: var(--cerulean-300);
    border-color: transparent;
  }

  /* ─── Seal-run control (split button: status picker + action) ──────
     Used in the run detail header for in_progress runs. The whole thing
     reads as one rounded segmented control: a status picker on the left,
     a primary action on the right, joined visually by a hairline divider.
     Status color tints the picker so the visual matches what'll be
     written. */
  .seal-control {
    display: inline-flex;
    align-items: stretch;
    height: 30px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    overflow: hidden;
    transition: border-color var(--duration-fast) var(--ease-out),
                box-shadow var(--duration-fast) var(--ease-out);
  }
  .seal-control:hover { border-color: var(--border-strong); }
  .seal-control:focus-within {
    border-color: var(--cerulean-400);
    box-shadow: var(--focus-ring);
  }
  .seal-status-select {
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    border: 0;
    border-radius: 0;
    padding: 0 24px 0 12px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    line-height: 28px;
    cursor: pointer;
    /* Custom chevron — keeps the control compact without a browser caret. */
    background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
                      linear-gradient(135deg, currentColor 50%, transparent 50%);
    background-position: calc(100% - 13px) 13px, calc(100% - 9px) 13px;
    background-size: 4px 4px, 4px 4px;
    background-repeat: no-repeat;
    transition: color var(--duration-fast) var(--ease-out),
                background-color var(--duration-fast) var(--ease-out);
  }
  .seal-status-select:focus { outline: none; box-shadow: none; }
  .seal-status-select:hover { background-color: var(--surface-2); color: var(--text-primary); }
  .seal-status-select[data-status="ok"]        { color: var(--mint-400); }
  .seal-status-select[data-status="error"]     { color: var(--coral-400); }
  .seal-status-select[data-status="abandoned"] { color: var(--amber-400); }
  .seal-control > button.seal-action {
    border: 0;
    border-left: 1px solid var(--border-default);
    border-radius: 0;
    height: 100%;
    padding: 0 14px;
    background: transparent;
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.01em;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-out),
                color var(--duration-fast) var(--ease-out);
  }
  .seal-control > button.seal-action:hover {
    background: var(--surface-2);
    color: var(--cerulean-300);
  }
  .seal-control > button.seal-action svg { display: block; }

  /* ─── v0.3 Files tab + run-level files summary ──────────────────
     Per SPEC §9 — reuses existing semantic palette (no new tokens
     except --cerulean-bg added in Turn 5's plan, not needed yet
     because the "selected file row" interaction lives in v0.5's
     working-tree panel). Op badges follow the spec mapping:
     mint A / amber M / coral D / violet R / dim X. */
  .files-summary {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    padding: 4px 0 var(--space-2);
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
  }
  .files-stat-add { color: var(--mint-400); }
  .files-stat-rm  { color: var(--coral-400); }
  .files-stat-count { color: var(--text-tertiary); }
  .file-list { display: flex; flex-direction: column; gap: 4px; }
  .file-row {
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    overflow: hidden;
  }
  .file-row-head {
    width: 100%;
    background: transparent;
    border: 0;
    padding: 8px 10px;
    text-align: left;
    display: grid;
    grid-template-columns: 22px 1fr auto auto auto;
    gap: 10px;
    align-items: center;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-primary);
    cursor: default;
  }
  .file-row-head.expandable { cursor: pointer; }
  .file-row-head.expandable:hover { background: var(--surface-2); }
  .file-row-head .file-row-caret {
    color: var(--text-tertiary);
    transition: transform var(--duration-fast) var(--ease-out);
  }
  .file-row.expanded .file-row-caret { transform: rotate(180deg); }
  .file-op {
    display: inline-block;
    width: 20px; height: 20px; line-height: 20px;
    text-align: center;
    border-radius: var(--radius-sm);
    font-weight: 600;
    font-size: 11px;
  }
  .file-op-create { color: var(--mint-400);    background: rgba(52, 211, 153, 0.12); }
  .file-op-modify { color: var(--amber-400);   background: rgba(245, 158, 11, 0.12); }
  .file-op-delete { color: var(--coral-400);   background: rgba(248, 113, 113, 0.12); }
  .file-op-rename { color: var(--violet-400);  background: rgba(167, 139, 250, 0.12); }
  .file-op-chmod  { color: var(--text-tertiary); background: var(--surface-2); }
  .file-path { color: var(--text-primary); overflow-wrap: anywhere; }
  .file-stats { display: inline-flex; gap: 6px; color: var(--text-tertiary); }
  .file-flag {
    display: inline-block;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .flag-partial   { color: var(--text-tertiary); background: var(--surface-2); }
  .flag-binary    { color: var(--text-secondary); background: var(--surface-2); }
  .flag-redacted  { color: var(--coral-400); border: 1px solid var(--coral-400); }
  .file-diff {
    background: var(--surface-0);
    border-top: 1px solid var(--border-subtle);
    margin: 0;
    padding: 10px 14px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    overflow-x: auto;
    white-space: pre;
  }
  .file-diff .diff-add   { color: var(--mint-400); }
  .file-diff .diff-del   { color: var(--coral-400); }
  .file-diff .diff-hunk  { color: var(--cerulean-400); }
  .file-diff-empty {
    padding: 8px 14px;
    border-top: 1px solid var(--border-subtle);
    color: var(--text-tertiary);
    font-size: 12px;
    font-family: var(--font-mono);
  }
  .tab-count {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--text-tertiary);
    font-size: 10px;
    font-weight: 500;
  }

  /* Run-level "Files changed in this run" summary, below the timeline. */
  .run-files-summary {
    margin: var(--space-3) 0 var(--space-4);
    padding: var(--space-3);
    background: var(--surface-1);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
  }
  .run-files-summary > summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .run-files-summary > summary::-webkit-details-marker { display: none; }
  .run-files-totals {
    display: inline-flex;
    gap: var(--space-2);
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .run-files-list {
    margin-top: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .run-file-row {
    width: 100%;
    background: transparent;
    border: 0;
    padding: 6px 8px;
    text-align: left;
    display: grid;
    grid-template-columns: 22px 1fr auto auto auto;
    gap: 10px;
    align-items: center;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-out);
  }
  .run-file-row:hover { background: var(--surface-2); }
  .run-file-row-meta { color: var(--text-tertiary); font-size: 11px; }

  /* ─── Row-level seal (runs list) ─────────────────────────────────
     Ghost button that fades in on row hover. Avoids visual noise on
     long tables where most rows aren't actionable. */
  .runs-table tbody tr .row-seal {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-tertiary);
    padding: 4px 10px;
    font-size: 11.5px;
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
    border-radius: var(--radius-sm);
    opacity: 0.55;
    transition: opacity var(--duration-fast) var(--ease-out),
                color var(--duration-fast) var(--ease-out),
                border-color var(--duration-fast) var(--ease-out),
                background var(--duration-fast) var(--ease-out);
  }
  .runs-table tbody tr:hover .row-seal { opacity: 1; }
  .runs-table tbody tr .row-seal:hover {
    color: var(--mint-400);
    border-color: var(--mint-400);
    background: rgba(52, 211, 153, 0.08);
  }
  .runs-table tbody tr .row-seal::before {
    content: "✓";
    margin-right: 5px;
    opacity: 0.7;
  }

  /* ─── Inputs ────────────────────────────────────────────────────── */
  input, textarea, select {
    background: var(--surface-1);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    font: inherit;
    font-size: 13px;
    font-family: var(--font-sans);
    transition: border-color var(--duration-fast) var(--ease-out),
                box-shadow var(--duration-fast) var(--ease-out);
  }
  input:focus, textarea:focus, select:focus {
    outline: none;
    border-color: var(--cerulean-400);
    box-shadow: var(--focus-ring);
  }
  input::placeholder, textarea::placeholder { color: var(--text-tertiary); }
  textarea { min-height: 88px; resize: vertical; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.55; }

  /* ─── Filter bar ────────────────────────────────────────────────── */
  .filter-bar {
    display: flex; align-items: center; gap: var(--space-2);
    margin: 0 0 var(--space-3) 0; flex-wrap: wrap;
  }
  .filter-chip {
    padding: 4px 12px; border-radius: var(--radius-full);
    font-family: var(--font-mono); font-size: 11px;
    letter-spacing: 0.04em; text-transform: uppercase;
    background: transparent; border: 1px solid var(--border-default);
    color: var(--text-tertiary);
    cursor: pointer; user-select: none;
    transition: color var(--duration-fast) var(--ease-out),
                border-color var(--duration-fast) var(--ease-out),
                background var(--duration-fast) var(--ease-out);
  }
  .filter-chip:hover { color: var(--text-primary); border-color: var(--border-strong); }
  .filter-chip.active {
    color: var(--cerulean-400);
    border-color: var(--cerulean-400);
    background: rgba(56, 189, 248, 0.06);
  }
  .filter-input {
    background: var(--surface-1); border: 1px solid var(--border-default);
    color: var(--text-primary); border-radius: var(--radius-sm);
    padding: 5px 10px; font-size: 12.5px;
    min-width: 220px;
    font-family: var(--font-mono);
  }
  .filter-input:focus { outline: none; border-color: var(--cerulean-400); box-shadow: var(--focus-ring); }
  .filter-input::placeholder { color: var(--text-tertiary); }

  /* ─── Copy button ───────────────────────────────────────────────── */
  .copy-btn {
    background: transparent; border: 1px solid transparent;
    color: var(--text-tertiary);
    border-radius: var(--radius-xs);
    padding: 1px 6px; font-size: 11px;
    cursor: pointer; font-family: var(--font-mono);
    transition: color var(--duration-fast) var(--ease-out),
                border-color var(--duration-fast) var(--ease-out),
                background var(--duration-fast) var(--ease-out);
  }
  .copy-btn:hover {
    color: var(--text-primary);
    border-color: var(--border-default);
    background: var(--surface-2);
  }
  .copy-btn.copied { color: var(--mint-400); border-color: rgba(52,211,153,0.3); }

  /* ─── Keyboard help ─────────────────────────────────────────────── */
  .kbd-help {
    position: fixed; right: 24px; bottom: 24px; z-index: 80;
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    padding: 14px 18px;
    font-size: 12px;
    display: none;
    box-shadow: var(--elevation-2);
  }
  .kbd-help.open { display: block; }
  .kbd-help kbd {
    background: var(--surface-3); border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    padding: 1px 6px; border-radius: var(--radius-xs);
    font-family: var(--font-mono); font-size: 11px;
    color: var(--text-primary);
  }
  .kbd-help-toggle {
    position: fixed; right: 24px; bottom: 24px; z-index: 79;
    width: 32px; height: 32px; border-radius: var(--radius-full);
    background: var(--surface-2); border: 1px solid var(--border-default);
    color: var(--text-tertiary);
    cursor: pointer; padding: 0;
    font-size: 14px; line-height: 1;
    transition: color var(--duration-fast) var(--ease-out),
                border-color var(--duration-fast) var(--ease-out);
  }
  .kbd-help-toggle:hover { color: var(--cerulean-400); border-color: var(--cerulean-400); }

  /* ─── Timeline ──────────────────────────────────────────────────── */
  .timeline {
    display: flex; flex-wrap: wrap; gap: 4px;
    background: var(--surface-1); padding: var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md); margin-bottom: var(--space-3);
    position: sticky; top: 60px; z-index: 20;
    max-height: 144px; overflow-y: auto;
  }
  .timeline .blk {
    min-width: 18px; height: 22px; padding: 2px 7px;
    border-radius: var(--radius-xs); background: var(--surface-2);
    font-family: var(--font-mono); font-size: 11px;
    color: var(--text-tertiary);
    border: 1px solid var(--border-default);
    cursor: pointer; user-select: none;
    transition: border-color var(--duration-fast) var(--ease-out),
                color var(--duration-fast) var(--ease-out),
                background var(--duration-fast) var(--ease-out);
    line-height: 18px;
  }
  .timeline .blk:hover {
    color: var(--text-primary);
    border-color: var(--border-strong);
  }
  .timeline .blk.ok { color: var(--text-secondary); border-color: rgba(52,211,153,0.3); }
  .timeline .blk.error {
    background: var(--coral-bg); border-color: rgba(248,113,113,0.4); color: var(--coral-400);
  }
  .timeline .blk.in_progress { color: var(--cerulean-300); border-color: rgba(56,189,248,0.3); }
  .timeline .blk.active {
    color: var(--text-on-accent);
    background: var(--cerulean-400);
    border-color: var(--cerulean-400);
    box-shadow: 0 0 0 2px rgba(56,189,248,0.2);
  }

  /* ─── Step cards ────────────────────────────────────────────────── */
  .step-card {
    background: var(--surface-1);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-5) var(--space-6);
    margin-bottom: var(--space-3);
    scroll-margin-top: 80px;
    transition: border-color var(--duration-default) var(--ease-out),
                transform var(--duration-default) var(--ease-out),
                box-shadow var(--duration-default) var(--ease-out);
  }
  .step-card:hover {
    border-color: var(--border-strong);
  }
  .step-card.active {
    border-color: var(--cerulean-400);
    box-shadow: 0 0 0 1px var(--cerulean-400) inset,
                0 4px 32px -8px rgba(56, 189, 248, 0.16);
  }
  .step-card h3 { margin: 0 0 var(--space-3) 0; font-size: 13px; }
  .step-card .row-actions {
    display: flex; gap: var(--space-2); align-items: center;
  }
  .step-card .row-actions button {
    background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary);
    border-radius: var(--radius-sm); padding: 3px 10px; font-size: 11px;
  }
  .step-card .row-actions button:hover {
    color: var(--text-primary); border-color: var(--border-strong); background: var(--surface-2);
  }

  /* ─── Code blocks (decision/action/outcome bodies) ──────────────── */
  pre.body {
    background: var(--surface-0);
    border: 1px solid var(--border-default);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    max-height: 360px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--text-primary);
  }

  /* ─── Tab bar (per-step Decision/Action/etc.) ───────────────────── */
  .tab-bar { display: flex; gap: var(--space-1); margin-bottom: var(--space-3); }
  .tab-bar button {
    background: transparent; color: var(--text-tertiary);
    border: 1px solid transparent; border-radius: var(--radius-sm);
    padding: 5px 12px; cursor: pointer;
    font-family: var(--font-mono); font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.06em;
    transition: color var(--duration-fast) var(--ease-out),
                background var(--duration-fast) var(--ease-out);
  }
  .tab-bar button:hover { color: var(--text-primary); }
  .tab-bar button.active {
    color: var(--cerulean-400);
    background: var(--surface-2);
    border-color: var(--border-default);
  }

  /* ─── Meta row (run header) ─────────────────────────────────────── */
  .meta-row {
    display: flex; gap: var(--space-5); flex-wrap: wrap;
    font-size: 12.5px; color: var(--text-tertiary);
    margin-bottom: var(--space-4);
    font-family: var(--font-mono);
  }
  .meta-row .kv { display: inline-flex; gap: 6px; align-items: baseline; }
  .meta-row .kv strong {
    color: var(--text-tertiary); font-weight: 500;
    text-transform: uppercase; font-size: 10px; letter-spacing: 0.08em;
  }
  .meta-row .kv .val,
  .meta-row .kv > span:not(.copy-btn):not(.badge):not(.pill) {
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }

  /* ─── Annotations ───────────────────────────────────────────────── */
  .annotation {
    background: rgba(56, 189, 248, 0.05);
    border-left: 2px solid var(--cerulean-400);
    padding: var(--space-2) var(--space-3);
    margin: var(--space-2) 0;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    font-size: 12.5px;
  }
  .annotation strong { color: var(--text-primary); }

  /* ─── Diff rows ─────────────────────────────────────────────────── */
  .diff-row td { padding: var(--space-3) var(--space-4); }
  .diff-row.shared { opacity: 0.55; }
  .diff-row.context_diff td:nth-child(1) { border-left: 2px solid var(--amber-400); }
  .diff-row.decision_diff td:nth-child(1) { border-left: 2px solid var(--cerulean-400); }
  .diff-row.action_diff td:nth-child(1) { border-left: 2px solid var(--coral-400); }
  .diff-row.outcome_diff td:nth-child(1) { border-left: 2px solid var(--violet-400); }
  .diff-row.only_a td:nth-child(1) { border-left: 2px solid var(--coral-400); }
  .diff-row.only_b td:nth-child(1) { border-left: 2px solid var(--mint-400); }
  .diff-row.diverged td:nth-child(1) { border-left: 2px solid var(--violet-400); }

  .empty {
    color: var(--text-tertiary); font-style: italic;
    padding: var(--space-12) var(--space-6);
    text-align: center;
    border: 1px dashed var(--border-default);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }

  /* ─── Fleet grid ────────────────────────────────────────────────── */
  .fleet {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: var(--space-4);
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-5);
    position: relative;
    transition: border-color var(--duration-default) var(--ease-out),
                transform var(--duration-default) var(--ease-out),
                box-shadow var(--duration-default) var(--ease-out);
  }
  .card:hover {
    border-color: var(--border-strong);
    transform: translateY(-1px);
    box-shadow: var(--elevation-1);
  }
  .card .title-row {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: var(--space-3); gap: var(--space-3);
  }
  .card .title-row .title {
    font-weight: 600; font-size: 14px; letter-spacing: -0.005em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text-primary);
  }
  .card .title-row .title:hover { color: var(--cerulean-400); text-decoration: none; }
  .card .meta {
    font-family: var(--font-mono);
    font-size: 11px; color: var(--text-tertiary);
    display: flex; gap: var(--space-3); flex-wrap: wrap;
    margin-top: var(--space-3);
    letter-spacing: 0.02em;
  }
  .card .meta .kv { color: var(--text-secondary); }
  .card .meta .age { font-variant-numeric: tabular-nums; color: var(--text-tertiary); }

  /* Context utilization bar */
  .ctx-bar {
    height: 3px; background: var(--surface-3);
    border-radius: var(--radius-full);
    margin: var(--space-3) 0;
    position: relative; overflow: hidden;
  }
  .ctx-bar .fill {
    height: 100%;
    background: var(--cerulean-400);
    transition: width var(--duration-slow) var(--ease-out);
    border-radius: var(--radius-full);
  }
  .ctx-bar.warn .fill { background: var(--amber-400); }
  .ctx-bar.danger .fill { background: var(--coral-400); }

  .recent-tools {
    font-family: var(--font-mono); font-size: 11px;
    color: var(--text-secondary);
    display: flex; gap: 4px; flex-wrap: wrap; align-items: center;
  }
  /* Small mono-uppercase label rendered before the tool chips. Same
     idiom as section-label so the fleet card reads consistently with
     the rest of the system. */
  .recent-tools-label {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-tertiary);
    margin-right: 4px;
  }
  .recent-tools code {
    background: var(--surface-2);
    border: 1px solid var(--border-subtle);
    padding: 1px 6px; border-radius: var(--radius-xs);
    color: var(--cerulean-300);
  }
  .alert-strip {
    margin-top: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: 11.5px;
    font-family: var(--font-mono);
    background: var(--coral-bg); color: var(--coral-400);
    border: 1px solid rgba(248,113,113,0.25);
  }
  .alert-strip.warn {
    background: var(--amber-bg); color: var(--amber-400);
    border-color: rgba(251,191,36,0.25);
  }

  .static-banner {
    background: var(--surface-1);
    border: 1px solid var(--border-default);
    border-left: 2px solid var(--cerulean-400);
    border-radius: var(--radius-sm);
    padding: var(--space-3) var(--space-4);
    font-size: 12.5px; color: var(--text-secondary);
    margin-bottom: var(--space-4);
  }
  .static-banner strong { color: var(--text-primary); }
  .static-banner code {
    background: var(--surface-2);
    border: 1px solid var(--border-default);
    padding: 1px 6px; border-radius: var(--radius-xs);
    color: var(--cerulean-300);
    font-family: var(--font-mono);
  }

  /* ─── Modals ────────────────────────────────────────────────────── */
  .modal-bg {
    position: fixed; inset: 0;
    background: rgba(8, 9, 11, 0.7);
    backdrop-filter: blur(4px);
    display: none; align-items: center; justify-content: center; z-index: 100;
  }
  .modal-bg.open { display: flex; }
  .modal {
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    padding: var(--space-6);
    width: 540px; max-width: 92vw;
    max-height: 80vh; overflow: auto;
    box-shadow: var(--elevation-2);
  }
  .modal h3 { margin: 0 0 var(--space-4) 0; font-size: 16px; font-weight: 600; }
  .modal label {
    display: block;
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-tertiary);
    margin-bottom: var(--space-1);
    margin-top: var(--space-3);
  }
  .modal input, .modal textarea, .modal select { width: 100%; }
  .modal .actions {
    margin-top: var(--space-5); display: flex;
    gap: var(--space-2); justify-content: flex-end;
  }

  /* ─── Tests page ────────────────────────────────────────────────── */
  .tests-grid {
    display: grid; grid-template-columns: 280px 1fr;
    gap: var(--space-4); min-height: 400px;
  }
  .test-list {
    background: var(--surface-1);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-2);
    overflow: auto; max-height: 75vh;
  }
  .test-list .item {
    display: block; padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    color: var(--text-primary); cursor: pointer; font-size: 13px;
    transition: background var(--duration-fast) var(--ease-out);
  }
  .test-list .item:hover { background: var(--surface-2); text-decoration: none; }
  .test-list .item.active {
    background: var(--surface-2);
    color: var(--cerulean-400);
    border-left: 2px solid var(--cerulean-400);
  }
  .test-list .item .meta {
    font-family: var(--font-mono);
    font-size: 11px; color: var(--text-tertiary);
    margin-top: 2px;
  }
  .test-detail {
    background: var(--surface-1);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: var(--space-5) var(--space-6);
    min-height: 200px;
  }
  .assertion-row {
    display: grid;
    grid-template-columns: 180px 1fr 90px 32px;
    gap: var(--space-2); align-items: center;
    padding: var(--space-2) 0;
    border-bottom: 1px dashed var(--border-subtle);
  }
  .assertion-row select, .assertion-row input { padding: 5px 8px; font-size: 12.5px; }
  .assertion-row .rm {
    background: transparent; color: var(--coral-400); border: none; cursor: pointer;
    font-size: 16px; line-height: 1;
  }
  .assertion-row .rm:hover { color: var(--coral-500); background: transparent; border: none; }
  .results-list {
    margin-top: var(--space-4);
    border-top: 1px solid var(--border-subtle); padding-top: var(--space-3);
  }
  .results-list .row {
    font-family: var(--font-mono); font-size: 12px;
    padding: 3px 0;
    letter-spacing: 0.02em;
  }
  .results-list .pass { color: var(--mint-400); }
  .results-list .fail { color: var(--coral-400); }

  /* ─── Reduced motion ────────────────────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
      scroll-behavior: auto !important;
    }
  }

  /* ─── API-metered cost disclosure ──────────────────────────────── */
  /* Tooltip-style marker rendered inline next to every $cost figure.
     Subscription users (Claude Pro / Max) don't pay these dollars —
     Spool's number is the API-equivalent rate, and the API rate itself
     reflects VC-subsidized 2026 pricing. Tooltip on the chip spells
     this out; the cost-footnote block at the page bottom expands. */
  .cost-mark {
    display: inline-flex; align-items: center;
    margin-left: var(--space-1);
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.06em;
    color: var(--text-tertiary);
    border: 1px solid var(--border-default);
    background: var(--surface-2);
    padding: 1px 4px;
    border-radius: var(--radius-xs);
    cursor: help;
    text-transform: uppercase;
    vertical-align: middle;
    transition: color var(--duration-fast) var(--ease-out),
                border-color var(--duration-fast) var(--ease-out);
  }
  .cost-mark:hover {
    color: var(--cerulean-300);
    border-color: var(--cerulean-400);
  }

  .cost-footnote {
    margin-top: var(--space-8);
    padding: var(--space-3) var(--space-4);
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-secondary);
    background: var(--surface-1);
    border: 1px solid var(--border-default);
    border-left: 2px solid var(--cerulean-400);
    border-radius: var(--radius-sm);
  }
  .cost-footnote strong { color: var(--text-primary); }
  .cost-footnote em { color: var(--cerulean-300); font-style: normal; }
  .cost-footnote .label {
    color: var(--cerulean-400);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.1em;
    font-family: var(--font-mono);
    margin-right: var(--space-2);
  }
`;

const SCRIPT = `
function fmtAge(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}
function costStr(cents) {
  const dollars = cents / 100;
  if (dollars === 0) return '$0.00';
  if (Math.abs(dollars) >= 0.005) return '$' + dollars.toFixed(2);
  return '$' + dollars.toFixed(4);
}
const COST_MARK = '<span class="cost-mark" title="API-equivalent rate. (1) Subscription users (Pro/Max) pay a flat fee, not this. (2) Reflects VC-subsidized 2026 pricing — training and cluster CapEx aren\\'t in the per-token bill. Use for relative comparison only.">api·metered</span>';
function ctxBarClass(pct) {
  if (pct >= 90) return 'ctx-bar danger';
  if (pct >= 70) return 'ctx-bar warn';
  return 'ctx-bar';
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function renderFleetEntry(e) {
  const r = e.run;
  const tools = (e.recent_tools || []).map(t => '<code>' + escapeHtml(t) + '</code>').join('');
  const alerts = (e.alerts || []).map(a => '<div class="alert-strip ' + (a.kind === 'stall' ? 'warn' : '') + '">' + escapeHtml(a.message) + '</div>').join('');
  return '<div class="card" data-run="' + escapeHtml(r.run_id) + '">'
    + '<div class="title-row">'
    +   '<a class="title" href="/runs/' + escapeHtml(r.run_id) + '">' + escapeHtml(r.title || r.run_id) + '</a>'
    +   '<span class="pill live-' + escapeHtml(e.status) + '">' + escapeHtml(e.status) + '</span>'
    + '</div>'
    + '<div class="meta">'
    +   '<span class="kv">' + r.step_count + ' steps</span>'
    +   '<span class="kv">' + costStr(r.cost_cents) + COST_MARK + '</span>'
    +   '<span class="kv">' + escapeHtml(r.git_branch || '') + '</span>'
    +   '<span class="age" data-age="' + escapeHtml(e.last_step_at || '') + '">' + fmtAge(e.last_step_at) + '</span>'
    + '</div>'
    + '<div class="' + ctxBarClass(e.context_pct) + '" title="context util ' + e.context_pct + '%"><div class="fill" style="width:' + e.context_pct + '%"></div></div>'
    + '<div class="recent-tools"><span class="recent-tools-label">Recent Tools Used</span>' + (tools || '<span style="opacity:0.5">no tools yet</span>') + '</div>'
    + alerts
    + '</div>';
}
function tickAges() {
  document.querySelectorAll('[data-age]').forEach(el => {
    el.textContent = fmtAge(el.dataset.age);
  });
}
function isLiveMode() {
  const meta = document.querySelector('meta[name="spool-live-mode"]');
  return meta && meta.getAttribute('content') === '1';
}
function startLive() {
  // The "tick ages every second" loop is useful in both modes; the
  // SSE EventSource only makes sense when --live is on.
  if (document.getElementById('fleet-grid')) {
    setInterval(tickAges, 1000);
    tickAges();
  }
  if (!isLiveMode() || typeof EventSource === 'undefined') return;
  const root = document.getElementById('fleet-grid');
  if (!root) return;
  const src = new EventSource('/api/live');
  src.addEventListener('fleet:snapshot', (ev) => {
    const data = JSON.parse(ev.data);
    root.innerHTML = data.entries.map(renderFleetEntry).join('') || '<div class="empty">No active runs.</div>';
  });
  src.addEventListener('alert', (ev) => {
    const data = JSON.parse(ev.data);
    const banner = document.getElementById('alert-banner');
    if (!banner) return;
    const div = document.createElement('div');
    div.className = 'alert-strip';
    div.innerHTML = '<strong>' + escapeHtml(data.kind) + '</strong> · ' + escapeHtml(data.message) + ' · <a href="/runs/' + escapeHtml(data.run_id) + '">open</a>';
    banner.appendChild(div);
    setTimeout(() => div.remove(), 12000);
  });
}
window.addEventListener('DOMContentLoaded', startLive);

function showTab(stepId, tab) {
  const tabs = document.querySelectorAll('[data-step="' + stepId + '"] .tab');
  tabs.forEach(t => t.style.display = 'none');
  const target = document.querySelector('[data-step="' + stepId + '"] .tab.tab-' + tab);
  if (target) target.style.display = '';
  document.querySelectorAll('[data-step="' + stepId + '"] .tab-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('[data-step="' + stepId + '"] .tab-btn[data-tab="' + tab + '"]');
  if (btn) btn.classList.add('active');
}
function jumpToStep(seq, opts) {
  // Scroll the step CARD into view, not the timeline block (which shares
  // the data-seq attribute). Sticky header offset is handled in CSS via
  // scroll-margin-top on .step-card.
  const card = document.getElementById('step-' + seq);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setActiveStep(seq);
  if (!(opts && opts.skipHash)) {
    history.replaceState(null, '', '#step-' + seq);
  }
}
function setActiveStep(seq) {
  document.querySelectorAll('.blk').forEach(b => b.classList.remove('active'));
  const blk = document.querySelector('.blk[data-seq="' + seq + '"]');
  if (blk) {
    blk.classList.add('active');
    // Keep the active block in view as user scrolls past it.
    blk.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
  document.querySelectorAll('.step-card.active').forEach(c => c.classList.remove('active'));
  const card = document.getElementById('step-' + seq);
  if (card) card.classList.add('active');
}

/* --- IntersectionObserver: highlight whichever step is in view --- */
function initStepObserver() {
  const cards = Array.from(document.querySelectorAll('.step-card[data-step-seq]'));
  if (cards.length === 0) return;
  const visible = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.set(e.target, e.intersectionRatio);
      else visible.delete(e.target);
    }
    // Pick the most-visible card; on ties, the one earliest in the DOM.
    let best = null; let bestRatio = -1;
    for (const [el, ratio] of visible) {
      if (ratio > bestRatio) { best = el; bestRatio = ratio; }
    }
    if (best) {
      const seq = best.getAttribute('data-step-seq');
      if (seq !== null) setActiveStep(Number(seq));
    }
  }, { threshold: [0, 0.2, 0.5, 1], rootMargin: '-80px 0px -50% 0px' });
  cards.forEach(c => io.observe(c));
}

/* --- Keyboard navigation --- */
function initKeyboardNav() {
  const cards = () => Array.from(document.querySelectorAll('.step-card[data-step-seq]'));
  const currentSeq = () => {
    const active = document.querySelector('.step-card.active');
    return active ? Number(active.getAttribute('data-step-seq')) : -1;
  };
  document.addEventListener('keydown', (e) => {
    // Don't intercept while typing in inputs/textareas.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const all = cards();
    if (all.length === 0) return;
    const cur = currentSeq();
    let next = null;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      next = all.find(c => Number(c.getAttribute('data-step-seq')) > cur);
      if (!next) next = all[all.length - 1];
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      const before = all.filter(c => Number(c.getAttribute('data-step-seq')) < cur);
      next = before[before.length - 1] || all[0];
    } else if (e.key === 'g') {
      next = all[0];
    } else if (e.key === 'G') {
      next = all[all.length - 1];
    } else if (e.key === '/') {
      const f = document.getElementById('step-filter');
      if (f) { e.preventDefault(); f.focus(); }
      return;
    } else if (e.key === '?') {
      const help = document.getElementById('kbd-help');
      if (help) { e.preventDefault(); help.classList.toggle('open'); }
      return;
    } else {
      return;
    }
    if (next) {
      e.preventDefault();
      jumpToStep(Number(next.getAttribute('data-step-seq')));
    }
  });
}

/* --- URL hash on load --- */
function restoreFromHash() {
  const m = (location.hash || '').match(/^#step-(\\d+)$/);
  if (!m) return;
  // wait a tick so layout is final
  setTimeout(() => jumpToStep(Number(m[1]), { skipHash: true }), 30);
}

/* --- Filter chips --- */
function applyFilter(kind) {
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.kind === kind));
  const cards = document.querySelectorAll('.step-card[data-step-seq]');
  cards.forEach(c => {
    const action = c.getAttribute('data-action-kind') || '';
    const status = c.getAttribute('data-step-status') || '';
    let show = true;
    if (kind === 'tools') show = action === 'tool_call';
    else if (kind === 'messages') show = action === 'message';
    else if (kind === 'errors') show = status === 'error';
    c.style.display = show ? '' : 'none';
  });
  const query = (document.getElementById('step-filter') || {}).value || '';
  if (query) applyTextFilter(query);
}
function applyTextFilter(q) {
  const ql = q.toLowerCase();
  document.querySelectorAll('.step-card[data-step-seq]').forEach(c => {
    if (c.style.display === 'none') return; // already filtered out by chip
    const text = (c.innerText || '').toLowerCase();
    c.style.display = !ql || text.includes(ql) ? '' : 'none';
  });
}

/* --- v0.3 Files tab — per-row diff toggle --- */
function toggleFileDiff(rowId) {
  const container = document.getElementById(rowId);
  if (!container) return;
  const pre = container.querySelector('.file-diff');
  if (!pre) return;
  const showing = pre.style.display !== 'none';
  pre.style.display = showing ? 'none' : '';
  const row = container.closest('.file-row');
  if (row) row.classList.toggle('expanded', !showing);
}

/* --- Copy to clipboard --- */
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML = '✓ copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1200);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initStepObserver();
  initKeyboardNav();
  restoreFromHash();
  initLiveToggle();
  initLiveRunUpdates();
});

/* --- v0.3 Live toggle ---
 * Click handler for the header button. Hits POST /api/live/start or
 * /api/live/stop, then mirrors the response into the data-live
 * attribute so the CSS picks up the new state. On success we also
 * flip the meta tag so other components polling spool-live-mode
 * see the change.
 *
 * The button is disabled during the request to prevent double-fire,
 * and the failure path surfaces a flash message instead of silently
 * leaving the user staring at a button that did nothing. */
async function toggleLive(event) {
  const btn = (event && event.currentTarget) || document.getElementById('live-toggle');
  if (!btn) return;
  const goingLive = btn.dataset.live !== '1';
  btn.setAttribute('disabled', '1');
  try {
    const res = await fetch('/api/live/' + (goingLive ? 'start' : 'stop'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    applyLiveState(body && body.live);
  } catch (err) {
    flash('live toggle failed: ' + (err.message || err), 'err');
  } finally {
    btn.removeAttribute('disabled');
  }
}

function applyLiveState(isLive) {
  const btn = document.getElementById('live-toggle');
  if (btn) {
    btn.dataset.live = isLive ? '1' : '0';
    const dot = btn.querySelector('.dot');
    if (dot) {
      dot.classList.toggle('dot--success', !!isLive);
      dot.classList.toggle('dot--muted', !isLive);
    }
    const label = btn.querySelector('.live-toggle-label');
    if (label) label.textContent = isLive ? 'LIVE' : 'GO LIVE';
    btn.title = isLive
      ? 'Click to stop live capture'
      : 'Click to start watching ~/.claude/projects for live agent activity';
  }
  const meta = document.querySelector('meta[name="spool-live-mode"]');
  if (meta) meta.setAttribute('content', isLive ? '1' : '0');
  // Tell any subscribed page features to react to the state change.
  document.dispatchEvent(
    new CustomEvent('spool:live-state', { detail: { live: !!isLive } }),
  );
}

function initLiveToggle() {
  // Sync the button with /api/live/status on load — covers the case
  // where someone hit start in another tab between renders.
  fetch('/api/live/status')
    .then((r) => (r.ok ? r.json() : null))
    .then((b) => {
      if (b && typeof b.live === 'boolean') applyLiveState(b.live);
    })
    .catch(() => { /* silent — toggle still works via click */ });
}

function flash(msg, kind) {
  const el = document.getElementById('flash');
  if (!el) return;
  el.textContent = msg;
  el.dataset.kind = kind || 'info';
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 3000);
}

/* --- v0.3 Live run updates ---
 * On a /runs/:id page, open an EventSource and append new step cards
 * as they arrive — no more hard refresh to see the agent's progress.
 *
 * Strategy: we know the current run's id from a data attribute on
 * the main element (set by renderRun). On run:updated events for
 * this run, fetch the missing step cards via the new
 * GET /api/runs/:id/step-card/:seq fragment endpoint and append.
 * The timeline gets a new block in lockstep so the scrubber stays
 * in sync.
 *
 * Why fetch HTML fragments rather than JSON: the step card has a lot
 * of structural decisions (tabs, copy buttons, monospace path padding)
 * that the server already does well. Rebuilding all of that in JS
 * would duplicate render logic — fragments keep one source of truth. */
function initLiveRunUpdates() {
  const main = document.querySelector('main');
  const runId = main && main.dataset && main.dataset.runId;
  if (!runId) return;
  let es;
  let knownStepCount = parseInt(main.dataset.stepCount || '0', 10) || 0;
  function ensureSubscribed() {
    if (es && es.readyState !== 2) return;
    try { es = new EventSource('/api/live'); } catch { return; }
    es.addEventListener('run:updated', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (!data || !data.run || data.run.run_id !== runId) return;
        // The server tells us how many steps the run has now; we
        // fetch any sequences past our last-known count and append.
        appendStepsUpTo(data.run.step_count || 0);
      } catch (err) { /* ignore parse errors */ }
    });
    es.addEventListener('run:completed', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data && data.run && data.run.run_id === runId) {
          flash('run completed — refresh for the final timeline view', 'info');
        }
      } catch { /* ignore */ }
    });
    es.onerror = () => {
      // Browser will auto-reconnect; nothing to do.
    };
  }
  async function appendStepsUpTo(target) {
    while (knownStepCount < target) {
      const seq = knownStepCount;
      try {
        const res = await fetch(
          '/api/runs/' + encodeURIComponent(runId) + '/step-card/' + seq,
        );
        if (!res.ok) break; // server doesn't have the row yet — retry next event
        const html = await res.text();
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        // The fragment endpoint wraps the card + timeline block in a
        // single <div data-step-fragment="1">. We move each piece to
        // its real home, then drop the wrapper.
        const fragment = wrap.querySelector('[data-step-fragment]');
        if (!fragment) break;
        const card = fragment.querySelector('.step-card');
        const tlBlock = fragment.querySelector('[data-timeline-blk]');
        if (card) {
          const stepsAnchor = document.getElementById('steps-anchor');
          if (stepsAnchor) {
            // Replace the placeholder "no steps" empty state on the
            // first append.
            const placeholder = stepsAnchor.querySelector('.empty');
            if (placeholder) placeholder.remove();
            stepsAnchor.appendChild(card);
          } else {
            main.appendChild(card);
          }
        }
        if (tlBlock) {
          const tl = document.querySelector('.timeline');
          if (tl) tl.appendChild(tlBlock);
        }
        knownStepCount = seq + 1;
        main.dataset.stepCount = String(knownStepCount);
        flash('step #' + seq + ' captured live', 'info');
      } catch {
        break;
      }
    }
  }
  // Only subscribe when live is on; otherwise wait for the toggle.
  function maybeSubscribe(isLive) {
    if (isLive) ensureSubscribed();
  }
  const meta = document.querySelector('meta[name="spool-live-mode"]');
  maybeSubscribe(meta && meta.getAttribute('content') === '1');
  document.addEventListener('spool:live-state', (e) => {
    maybeSubscribe(e.detail && e.detail.live);
  });
}

/* --- Modal helpers --- */
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

/* --- Fork modal --- */
function openForkModal(runId, sequence, defaultText) {
  document.getElementById('fork-run-id').value = runId;
  document.getElementById('fork-seq').value = sequence;
  document.getElementById('fork-payload').value = defaultText || '';
  document.getElementById('fork-status').textContent = '';
  openModal('fork-modal');
}
async function submitFork() {
  const status = document.getElementById('fork-status');
  status.textContent = 'forking…';
  status.style.color = 'var(--fg-mute)';
  const continueMode = document.getElementById('fork-continue').value;
  const allowToolsRaw = (document.getElementById('fork-allow-tools') || {}).value || '';
  const allowTools = allowToolsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const body = {
    origin_run_id: document.getElementById('fork-run-id').value,
    at: parseInt(document.getElementById('fork-seq').value, 10),
    edit_type: document.getElementById('fork-edit-type').value,
    edit_payload: { text: document.getElementById('fork-payload').value },
    fake: document.getElementById('fork-fake').value || undefined,
    live: document.getElementById('fork-live').checked,
    continue: continueMode === 'none' ? undefined : continueMode,
    max_iterations: parseInt(document.getElementById('fork-max-iter').value || '25', 10),
    model: document.getElementById('fork-model').value || undefined,
    allow_tools: allowTools.length ? allowTools : undefined,
  };
  if (continueMode !== 'none') status.textContent = 'forking + continuing (' + continueMode + ')…';
  try {
    const res = await fetch('/api/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'fork failed');
    let summary = 'fork created → <a href="/runs/' + data.fork_run_id + '">open</a> · <a href="/diff?a=' + body.origin_run_id + '&b=' + data.fork_run_id + '">diff</a>';
    if (data.continuation) {
      const c = data.continuation;
      const colorFor = (r) => r === 'model_completed' ? 'var(--ok)' : r === 'tool_error' || r === 'model_error' ? 'var(--err)' : 'var(--warn)';
      summary += '<br><span style="color:var(--fg-mute);font-size:11px">continued · ' + c.iterations + ' iterations · ' + c.steps_added + ' steps added · </span>';
      summary += '<span style="color:' + colorFor(c.terminal_reason) + ';font-size:11px">' + c.terminal_reason + '</span>';
    }
    status.innerHTML = summary;
    status.style.color = 'var(--fg)';
  } catch (err) {
    status.textContent = 'error: ' + err.message;
    status.style.color = 'var(--err)';
  }
}

/* --- Annotation --- */
function openAnnotateModal(targetKind, targetId) {
  document.getElementById('ann-kind').value = targetKind;
  document.getElementById('ann-id').value = targetId;
  document.getElementById('ann-note').value = '';
  document.getElementById('ann-verdict').value = '';
  document.getElementById('ann-status').textContent = '';
  openModal('annotate-modal');
}
async function submitAnnotation() {
  const status = document.getElementById('ann-status');
  status.textContent = 'saving…';
  const body = {
    target_kind: document.getElementById('ann-kind').value,
    target_id: document.getElementById('ann-id').value,
    verdict: document.getElementById('ann-verdict').value || undefined,
    note: document.getElementById('ann-note').value,
    author: 'web-ui',
  };
  try {
    const res = await fetch('/api/annotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('annotate failed');
    status.textContent = 'saved';
    setTimeout(() => { closeModal('annotate-modal'); location.reload(); }, 600);
  } catch (err) {
    status.textContent = 'error: ' + err.message;
  }
}

/* --- Run close (manual seal for in_progress runs) --- */
async function closeRun(runId, status) {
  const finalStatus = status || 'ok';
  const label = runId.slice(0, 12);
  if (!confirm('Close run ' + label + ' as "' + finalStatus + '"?\\n\\nProxy-captured runs stay in_progress until you close them — this is the manual seal.')) return;
  try {
    const res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: finalStatus }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + res.status));
    }
    location.reload();
  } catch (err) {
    alert('close failed: ' + err.message);
  }
}

async function closeStaleRuns() {
  const minStr = prompt('Close every in_progress run older than how many minutes?\\n\\n(Empty = 60. Use 0 to close all.)', '60');
  if (minStr === null) return;
  const minutes = minStr.trim() === '' ? 60 : parseInt(minStr, 10);
  if (!Number.isFinite(minutes) || minutes < 0) { alert('not a number'); return; }
  try {
    const res = await fetch('/api/runs/close-stale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ older_than_minutes: minutes, status: 'ok' }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const out = await res.json();
    alert('closed ' + out.closed + ' run(s)');
    location.reload();
  } catch (err) {
    alert('bulk close failed: ' + err.message);
  }
}

/* --- Test editor --- */
let currentTest = null;

async function selectTest(name) {
  document.querySelectorAll('.test-list .item').forEach(el =>
    el.classList.toggle('active', el.dataset.name === name)
  );
  const res = await fetch('/api/tests/' + encodeURIComponent(name));
  if (!res.ok) return;
  currentTest = await res.json();
  renderTestDetail(currentTest);
  loadResults(name);
}
function renderTestDetail(t) {
  const root = document.getElementById('test-detail');
  if (!t) { root.innerHTML = '<div class="empty">Select a test from the left.</div>'; return; }
  const rows = (t.assertions || []).map((a, i) => assertionRowHtml(a, i)).join('');
  root.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<h3 style="margin:0">' + escapeHtml(t.name) + '</h3>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        '<button onclick="addAssertionRow()">+ assertion</button>' +
        ' <button class="primary" onclick="saveAssertions()">Save</button>' +
        ' <button onclick="runTestAgainstAll()">Run on all runs</button>' +
        ' <button onclick="deleteCurrentTest()" style="color:var(--err);border-color:var(--err)">Delete test</button>' +
      '</div>' +
    '</div>' +
    (t.description ? '<p style="color:var(--fg-mute);font-size:12.5px">' + escapeHtml(t.description) + '</p>' : '') +
    '<div id="assertions-area">' + rows + '</div>' +
    '<div style="margin-top:14px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
      '<input id="single-run-id" placeholder="run_… (full or 12-char prefix)"' +
      ' style="font-family:ui-monospace,Menlo,monospace;min-width:240px">' +
      ' <button onclick="runTestAgainstOne()">Run on this run</button>' +
      ' <span id="single-run-status" style="font-size:12px;color:var(--fg-mute);font-family:ui-monospace,Menlo,monospace"></span>' +
    '</div>' +
    '<div id="test-results" class="results-list"></div>';
}
function assertionRowHtml(a, i) {
  const kinds = ['includes_tool_call','excludes_tool_call','tool_call_count','output_contains','output_does_not_contain','min_steps','max_steps','final_status','max_cost_cents','no_error_step'];
  const opts = kinds.map(k => '<option value="' + k + '"' + (k === a.kind ? ' selected' : '') + '>' + k + '</option>').join('');
  return '<div class="assertion-row" data-idx="' + i + '">' +
    '<select onchange="updateAssertion(' + i + ', \\'kind\\', this.value)">' + opts + '</select>' +
    '<input value="' + escapeHtml(String(a.value || '')) + '" onchange="updateAssertion(' + i + ', \\'value\\', this.value)">' +
    '<input placeholder="label" value="' + escapeHtml(a.label || '') + '" onchange="updateAssertion(' + i + ', \\'label\\', this.value)">' +
    '<button class="rm" onclick="removeAssertion(' + i + ')" title="remove">×</button>' +
    '</div>';
}
function updateAssertion(idx, key, val) {
  if (!currentTest) return;
  if (key === 'value' && /^[\\d.]+$/.test(val) && currentTest.assertions[idx].kind !== 'final_status') val = Number(val);
  currentTest.assertions[idx][key] = val;
}
function addAssertionRow() {
  if (!currentTest) return;
  currentTest.assertions = currentTest.assertions || [];
  currentTest.assertions.push({ kind: 'includes_tool_call', value: '' });
  renderTestDetail(currentTest);
}
function removeAssertion(idx) {
  if (!currentTest) return;
  currentTest.assertions.splice(idx, 1);
  renderTestDetail(currentTest);
}
async function saveAssertions() {
  if (!currentTest) return;
  const res = await fetch('/api/tests/' + encodeURIComponent(currentTest.name) + '/assertions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assertions: currentTest.assertions }),
  });
  if (res.ok) {
    currentTest = await res.json();
    renderTestDetail(currentTest);
    flash('saved');
  } else {
    flash('save failed', true);
  }
}
async function deleteCurrentTest() {
  if (!currentTest) return;
  if (!confirm('Delete test "' + currentTest.name + '"? This is permanent.')) return;
  const res = await fetch('/api/tests/' + encodeURIComponent(currentTest.name), {
    method: 'DELETE',
  });
  if (res.ok) {
    flash('deleted ' + currentTest.name);
    setTimeout(() => location.reload(), 600);
  } else {
    flash('delete failed', true);
  }
}
async function runTestAgainstOne() {
  if (!currentTest) return;
  const id = (document.getElementById('single-run-id') || {}).value || '';
  if (!id) { setStatus('single-run-status', 'enter a run id', true); return; }
  setStatus('single-run-status', 'running…');
  try {
    const res = await fetch('/api/tests/' + encodeURIComponent(currentTest.name) + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'run failed');
    const r = data[0];
    if (!r) { setStatus('single-run-status', 'no result returned', true); return; }
    const passed = r.assertions.filter(a => a.passed).length;
    setStatus('single-run-status',
      (r.passed ? '✓ PASS' : '✗ FAIL') + '  ' + passed + '/' + r.assertions.length + '  ' + r.run_id.slice(0,12),
      !r.passed);
    loadResults(currentTest.name);
  } catch (err) {
    setStatus('single-run-status', 'error: ' + err.message, true);
  }
}
async function runTestAgainstAll() {
  if (!currentTest) return;
  flash('running…');
  const res = await fetch('/api/tests/' + encodeURIComponent(currentTest.name) + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 50 }),
  });
  const results = await res.json();
  const pass = results.filter(r => r.passed).length;
  const fail = results.length - pass;
  flash(pass + ' pass · ' + fail + ' fail', fail > 0);
  loadResults(currentTest.name);
}
async function loadResults(name) {
  const res = await fetch('/api/tests/' + encodeURIComponent(name) + '/results');
  const data = await res.json();
  const root = document.getElementById('test-results');
  if (!root) return;
  if (!data.length) { root.innerHTML = '<p style="color:var(--fg-mute);font-size:12px">No results yet.</p>'; return; }
  root.innerHTML = '<h4 style="margin:8px 0;font-size:12px;color:var(--fg-mute)">Recent results</h4>' +
    data.map(r =>
      '<div class="row ' + (r.passed ? 'pass' : 'fail') + '">' +
      (r.passed ? 'PASS' : 'FAIL') + '  ' +
      escapeHtml(r.run_id.slice(0,12)) + '  ' +
      r.assertions.filter(a => a.passed).length + '/' + r.assertions.length + '  ' +
      escapeHtml(r.created_at) +
      '</div>'
    ).join('');
}
async function createNewTest() {
  const name = prompt('New test name:');
  if (!name) return;
  const res = await fetch('/api/tests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (res.ok) location.reload();
}
function flash(msg, isError) {
  const el = document.getElementById('flash');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--err)' : 'var(--ok)';
  setTimeout(() => { el.textContent = ''; }, 2000);
}

/* ─── Settings page ────────────────────────────────────────────── */
function setStatus(id, msg, isError) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--err)' : 'var(--ok)';
}
async function saveSetting(key, value, statusId) {
  setStatus(statusId, 'saving…');
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'save failed');
    setStatus(statusId, 'saved');
  } catch (err) {
    setStatus(statusId, 'error: ' + err.message, true);
  }
}
async function saveDefaults() {
  const tools = (document.getElementById('watch-tools') || {}).value || '';
  const stall = (document.getElementById('stall-seconds') || {}).value || '120';
  const model = (document.getElementById('default-model') || {}).value || 'claude-opus-4-7';
  const iter = (document.getElementById('default-max-iter') || {}).value || '25';
  await saveSetting('live.watch_tools', tools, 'defaults-status');
  await saveSetting('live.stall_seconds', stall, 'defaults-status');
  await saveSetting('fork.default_model', model, 'defaults-status');
  await saveSetting('fork.default_max_iterations', iter, 'defaults-status');
  setStatus('defaults-status', 'all defaults saved');
}
async function runIngest(runtime) {
  const limit = parseInt((document.getElementById('ingest-limit') || {}).value || '5', 10);
  setStatus('ingest-status', 'ingesting ' + runtime + '…');
  try {
    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime, limit }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'ingest failed');
    const summary = runtime === 'cursor'
      ? data.composers + ' composer(s) · ' + data.steps + ' step(s)'
      : data.runs + ' run(s) · ' + data.steps + ' step(s) · ' + (data.bytes / 1024).toFixed(1) + 'KB';
    setStatus('ingest-status', '✓ ' + runtime + ': ' + summary);
  } catch (err) {
    setStatus('ingest-status', 'error: ' + err.message, true);
  }
}
async function runDoctor() {
  const root = document.getElementById('doctor-results');
  if (!root) return;
  root.innerHTML = '<span style="color:var(--fg-mute)">running…</span>';
  try {
    const res = await fetch('/api/doctor');
    const data = await res.json();
    const colorFor = (s) => s === 'ok' ? 'var(--ok)' : s === 'warn' ? 'var(--warn)' : 'var(--err)';
    const iconFor = (s) => s === 'ok' ? '✔' : s === 'warn' ? '⚠' : '✖';
    root.innerHTML = data.checks.map(c =>
      '<div style="padding:3px 0"><span style="color:' + colorFor(c.status) + ';margin-right:8px">' + iconFor(c.status) + '</span>' +
      '<strong style="color:var(--fg)">' + escapeHtml(c.name) + '</strong> ' +
      '<span style="color:var(--fg-mute);margin-left:8px">' + escapeHtml(c.detail) + '</span></div>'
    ).join('');
  } catch (err) {
    root.innerHTML = '<span style="color:var(--err)">' + escapeHtml(err.message) + '</span>';
  }
}
async function testSlack() {
  const webhook = (document.getElementById('slack-webhook') || {}).value;
  setStatus('slack-status', 'sending…');
  try {
    const res = await fetch('/api/slack/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook: webhook && !webhook.startsWith('(') ? webhook : undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'send failed');
    setStatus('slack-status', '✓ test message sent');
  } catch (err) {
    setStatus('slack-status', 'error: ' + err.message, true);
  }
}
async function postgresInit() {
  const url = (document.getElementById('pg-url') || {}).value;
  setStatus('pg-status', 'connecting…');
  try {
    const res = await fetch('/api/db/postgres-init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url && !url.startsWith('(') ? url : undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'connect failed');
    setStatus('pg-status', '✓ schema_version=' + data.schema_version);
  } catch (err) {
    setStatus('pg-status', 'error: ' + err.message, true);
  }
}
async function postgresSync() {
  const url = (document.getElementById('pg-url') || {}).value;
  setStatus('pg-status', 'syncing…');
  try {
    const res = await fetch('/api/db/postgres-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url && !url.startsWith('(') ? url : undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'sync failed');
    setStatus('pg-status', '✓ ' + data.runs + ' runs · ' + data.steps + ' steps · ' + data.blobs + ' blobs (' + (data.bytes/1024).toFixed(1) + 'KB)');
  } catch (err) {
    setStatus('pg-status', 'error: ' + err.message, true);
  }
}
`;

export interface ShellOptions {
  /** True when `spool web --live` is on. Controls the SSE EventSource
   *  startup and the small "live" badge in the nav. */
  liveMode?: boolean;
}

export function renderShell(
  title: string,
  body: string,
  opts: ShellOptions = {},
): string {
  // Interactive Live toggle. The initial state comes from
  // `opts.liveMode` (server's view at render time); the button polls
  // and updates `data-live` on click so subsequent renders aren't
  // necessary to flip the badge.
  const liveToggle = `<button id="live-toggle" class="live-toggle"
      data-live="${opts.liveMode ? "1" : "0"}"
      title="${opts.liveMode ? "Click to stop live capture" : "Click to start watching ~/.claude/projects for live agent activity"}"
      onclick="toggleLive(event)"><span class="dot dot--${opts.liveMode ? "success" : "muted"}"></span><span class="live-toggle-label">${opts.liveMode ? "LIVE" : "GO LIVE"}</span></button>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)} · Spool</title>
<meta name="spool-live-mode" content="${opts.liveMode ? "1" : "0"}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${STYLES}</style>
</head><body>
<header>
  <a class="brand" href="/">
    <span class="brand-mark"></span>
    <span class="brand-name">Spool</span>
  </a>
  <nav class="topnav">
    <a href="/">Fleet</a>
    <a href="/runs">Runs</a>
    <a href="/tests">Tests</a>
    <a href="/settings">Settings</a>
  </nav>
  ${liveToggle}
  <span class="crumbs">${esc(title)}</span>
  <span id="flash"></span>
</header>
<main>${body}</main>

<!-- Fork modal -->
<div id="fork-modal" class="modal-bg" onclick="if(event.target===this)closeModal('fork-modal')">
  <div class="modal">
    <h3>Fork from this step</h3>
    <input type="hidden" id="fork-run-id">
    <input type="hidden" id="fork-seq">
    <label>Edit type</label>
    <select id="fork-edit-type">
      <option value="replace_user_message">replace_user_message</option>
      <option value="inject_message">inject_message</option>
      <option value="replace_system_prompt">replace_system_prompt</option>
      <option value="modify_tool_description">modify_tool_description</option>
      <option value="add_context">add_context</option>
      <option value="remove_tool">remove_tool</option>
      <option value="change_model">change_model</option>
    </select>
    <label>Payload (becomes <code>{ text: ... }</code>)</label>
    <textarea id="fork-payload" placeholder="The new message text…"></textarea>
    <label>Fake suffix response (optional — leave blank for live mode)</label>
    <input id="fork-fake" placeholder="Acknowledged.">
    <label style="display:flex;gap:8px;align-items:center;margin-top:6px">
      <input type="checkbox" id="fork-live" style="width:auto"> Use live Anthropic call (requires ANTHROPIC_API_KEY)
    </label>

    <hr style="border:0;border-top:1px solid var(--border);margin:16px 0">
    <label>Continuation (multi-step replay)</label>
    <select id="fork-continue">
      <option value="none">None — one suffix step only</option>
      <option value="simulate">Simulate — replay model live, use original tool results</option>
      <option value="live">Live — replay model + execute tools (Bash safe-list)</option>
    </select>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
      <label style="font-size:12px;color:var(--fg-mute)">Max iterations
        <input id="fork-max-iter" type="number" min="1" max="100" value="25" style="margin-top:4px">
      </label>
      <label style="font-size:12px;color:var(--fg-mute)">Live model (continuation)
        <input id="fork-model" value="claude-opus-4-7" style="margin-top:4px;font-family:ui-monospace,Menlo,monospace">
      </label>
    </div>
    <label style="margin-top:8px">Allowed tools for live continuation (comma-separated)</label>
    <input id="fork-allow-tools" placeholder="Bash" style="font-family:ui-monospace,Menlo,monospace">

    <div class="actions">
      <button onclick="closeModal('fork-modal')">Cancel</button>
      <button class="primary" onclick="submitFork()">Fork</button>
    </div>
    <p id="fork-status" style="font-size:12px;color:var(--fg-mute);margin-top:10px"></p>
  </div>
</div>

<!-- Annotate modal -->
<div id="annotate-modal" class="modal-bg" onclick="if(event.target===this)closeModal('annotate-modal')">
  <div class="modal">
    <h3>Annotate</h3>
    <input type="hidden" id="ann-kind">
    <input type="hidden" id="ann-id">
    <label>Verdict</label>
    <select id="ann-verdict">
      <option value="">(none)</option>
      <option value="correct">correct</option>
      <option value="incorrect">incorrect</option>
      <option value="unclear">unclear</option>
      <option value="good_decision">good_decision</option>
      <option value="bad_decision">bad_decision</option>
    </select>
    <label>Note</label>
    <textarea id="ann-note" placeholder="What surprised you about this step?"></textarea>
    <div class="actions">
      <button onclick="closeModal('annotate-modal')">Cancel</button>
      <button class="primary" onclick="submitAnnotation()">Save</button>
    </div>
    <p id="ann-status" style="font-size:12px;color:var(--fg-mute);margin-top:10px"></p>
  </div>
</div>

<!-- Keyboard help -->
<div id="kbd-help" class="kbd-help">
  <div style="font-weight:600;margin-bottom:6px">Keyboard shortcuts</div>
  <div><kbd>j</kbd> / <kbd>↓</kbd> next step</div>
  <div><kbd>k</kbd> / <kbd>↑</kbd> previous step</div>
  <div><kbd>g</kbd> first step · <kbd>G</kbd> last step</div>
  <div><kbd>/</kbd> focus text filter</div>
  <div><kbd>?</kbd> toggle this help</div>
</div>
<button class="kbd-help-toggle" title="keyboard shortcuts (?)" onclick="document.getElementById('kbd-help').classList.toggle('open')">?</button>

<script>${SCRIPT}</script>
</body></html>`;
}

export function renderFleet(
  entries: FleetEntry[],
  opts: { liveMode?: boolean } = {},
): string {
  const initial = entries.map((e) => fleetEntryHtml(e)).join("");
  const banner = opts.liveMode
    ? ""
    : `<div class="static-banner">
         <strong>Static snapshot.</strong> Status, context %, and recent tools are computed from captured data — no auto-updates.
         For live monitoring + alerts (Slack, loop / stall / context-threshold), restart with <code>spool web --live</code>.
       </div>`;
  const subtitle = opts.liveMode
    ? "live · auto-updating via SSE"
    : "static snapshot of last 50 runs · click any card to drill in";
  const empty = opts.liveMode
    ? `<div class="empty">No active runs yet. Open a Claude Code session and Spool will pick it up within a couple of seconds.</div>`
    : `<div class="empty">No runs captured. Run <code>spool ingest claude-code --limit 5</code>.</div>`;
  return `<div id="alert-banner" style="margin-bottom:var(--space-3)"></div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:var(--space-5)">
      <div>
        <div class="section-label">${opts.liveMode ? "Live · SSE" : "Snapshot"}</div>
        <h2 style="margin:0">Fleet</h2>
        <div style="font-size:12.5px;color:var(--text-tertiary);margin-top:var(--space-1)">${esc(subtitle)}</div>
      </div>
      <div class="meta-row" style="margin:0">
        <div class="kv"><strong>Runs</strong> <span class="val">${entries.length}</span></div>
        <div class="kv"><a href="/runs">All runs →</a></div>
      </div>
    </div>
    ${banner}
    <div id="fleet-grid" class="fleet">${initial || empty}</div>
    ${COST_FOOTNOTE_HTML}`;
}

function fleetEntryHtml(e: FleetEntry): string {
  const r = e.run;
  const tools = (e.recent_tools ?? [])
    .map((t) => `<code>${esc(t)}</code>`)
    .join("");
  const alerts = (e.alerts ?? [])
    .map(
      (a) =>
        `<div class="alert-strip ${a.kind === "stall" ? "warn" : ""}">${esc(a.message)}</div>`,
    )
    .join("");
  const barClass =
    e.context_pct >= 90 ? "ctx-bar danger" : e.context_pct >= 70 ? "ctx-bar warn" : "ctx-bar";
  return `<div class="card" data-run="${esc(r.run_id)}">
    <div class="title-row">
      <a class="title" href="/runs/${esc(r.run_id)}">${esc(r.title ?? r.run_id)}</a>
      <span class="pill live-${esc(e.status)}">${esc(e.status)}</span>
    </div>
    <div class="meta">
      <span class="kv">${r.step_count} steps</span>
      <span class="kv">${costEl(r.cost_cents)}</span>
      <span class="kv">${esc(r.git_branch ?? "")}</span>
      <span class="age" data-age="${esc(e.last_step_at ?? "")}"></span>
    </div>
    <div class="${barClass}" title="context util ${e.context_pct}%"><div class="fill" style="width:${e.context_pct}%"></div></div>
    <div class="recent-tools"><span class="recent-tools-label">Recent Tools used</span>${tools || '<span style="opacity:0.5">no tools yet</span>'}</div>
    ${alerts}
  </div>`;
}

export interface RunListOptions {
  totalAvailable?: number;
  filters?: { status?: string; tool?: string; project?: string };
}

export function renderRunList(
  runs: Run[],
  opts: RunListOptions = {},
): string {
  const filters = opts.filters ?? {};
  const total = opts.totalAvailable ?? runs.length;
  const isFiltered =
    !!filters.status || !!filters.tool || !!filters.project;
  // Bulk-seal action lives inside the filter bar's right-edge cluster —
  // discoverable when needed but not claiming a row of its own. Only
  // rendered when there's at least one in_progress run on the page.
  const hasInProgress = runs.some((r) => r.status === "in_progress");
  const bulkSeal = hasInProgress
    ? `<button type="button" class="tertiary"
        style="margin-left:8px;font-size:11.5px;font-family:ui-monospace,Menlo,monospace"
        title="Seal every in_progress run older than N minutes"
        onclick="closeStaleRuns()">Seal stale…</button>`
    : "";
  const filterBar = `<form id="runs-filter" method="get" action="/runs"
       style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
    <select name="status" onchange="this.form.submit()" style="font-family:ui-monospace,Menlo,monospace">
      <option value="">All statuses</option>
      ${["ok", "error", "in_progress", "abandoned"]
        .map(
          (s) =>
            `<option value="${s}"${filters.status === s ? " selected" : ""}>${s}</option>`,
        )
        .join("")}
    </select>
    <input name="tool" value="${esc(filters.tool ?? "")}"
      placeholder="filter by tool name (e.g. Bash)"
      style="font-family:ui-monospace,Menlo,monospace;min-width:200px">
    <input name="project" value="${esc(filters.project ?? "")}"
      placeholder="filter by project path substring"
      style="font-family:ui-monospace,Menlo,monospace;min-width:200px">
    <button type="submit" class="primary">Apply</button>
    ${isFiltered ? `<a href="/runs" style="font-size:12px">clear</a>` : ""}
    <span style="margin-left:auto;display:inline-flex;align-items:center;font-size:12px;color:var(--fg-mute);font-family:ui-monospace,Menlo,monospace">
      ${runs.length} of ${total} run(s)${bulkSeal}
    </span>
  </form>`;

  const empty = isFiltered
    ? `<div class="empty">No runs match the current filter. <a href="/runs">Clear filter</a>.</div>`
    : `<div class="empty">No runs captured yet. Run <code>spool ingest claude-code</code> to import sessions, or open the <a href="/settings">Settings page</a>.</div>`;

  const rows = runs
    .map((r) => {
      const status = `<span class="pill ${esc(r.status)}">${esc(r.status)}</span>`;
      const fork = r.fork_origin_run_id
        ? ` <span class="badge badge--premium">fork</span>`
        : "";
      const cost = costEl(r.cost_cents);
      const title = r.title ?? r.run_id;
      const project = projectLabel(r.cwd);
      const projectFull = r.cwd ?? "";
      // Row-level seal — ghost button, fades in on row hover. Defaults
      // to "ok"; the less-common error/abandoned cases are handled on
      // the run detail page where the picker lives.
      const actions =
        r.status === "in_progress"
          ? `<button class="row-seal" type="button"
              title="Seal this run as ok (mostly for proxy-captured runs)"
              onclick="closeRun('${esc(r.run_id)}', 'ok')">Seal</button>`
          : "";
      return `<tr>
        <td>
          <a href="/runs/${esc(r.run_id)}">${esc(title)}</a>${fork}
        </td>
        <td>${status}</td>
        <td class="mono">${esc(r.run_id.slice(0, 12))}</td>
        <td class="numeric">${r.step_count}</td>
        <td class="numeric">${cost}</td>
        <td class="mono">${esc(r.started_at)}</td>
        <td class="mono">${esc(r.git_branch ?? "")}</td>
        <td class="mono" title="${esc(projectFull)}">${esc(project)}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join("");
  return `<div style="margin-bottom:var(--space-5)">
      <div class="section-label">All runs</div>
      <h2 style="margin:0">${total} captured</h2>
    </div>
    ${filterBar}
    ${
      runs.length === 0
        ? empty
        : `<div class="table-scroll">
            <table class="runs-table">
              <thead><tr>
                <th>Title</th>
                <th>Status</th>
                <th>Run</th>
                <th>Steps</th>
                <th>Cost</th>
                <th>Started</th>
                <th>Branch</th>
                <th>Project</th>
                <th></th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`
    }
    ${COST_FOOTNOTE_HTML}`;
}

/**
 * Render `r.cwd` as a short, scannable project label — the trailing
 * 1–2 path segments. Full path stays in the cell's `title=` attribute
 * for hover. Examples:
 *   /Users/me/development/Spool-demo  →  Spool-demo
 *   /Users/me/dev/agents/customer-bot →  agents/customer-bot
 *   (cursor)                          →  cursor
 *   (unknown) / undefined             →  —
 */
function projectLabel(cwd: string | undefined): string {
  if (!cwd) return "—";
  const trimmed = cwd.replace(/\/+$/, "");
  if (trimmed === "(unknown)") return "—";
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return trimmed.slice(1, -1);
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length === 0) return trimmed;
  if (parts.length === 1) return parts[0]!;
  // Show parent/child for the common /Users/X/dev/<parent>/<repo> pattern
  // so a grid of similarly-named repos is distinguishable.
  return parts.slice(-2).join("/");
}

export function renderRun(
  run: Run,
  steps: Step[],
  annotations: Annotation[],
  forks: Array<{ fork_id: string; fork_run_id: string; edit_type: string; origin_step_id: string }>,
  stepDecisions: Map<string, string>,
  /**
   * v0.3 — FileChange rows grouped by step_id. Empty map when the run
   * has no file capture (proxy / non-coding / pre-v0.3). When non-
   * empty, each step card gets a Files tab and a run-level "Files
   * changed in this run" summary appears below the timeline.
   */
  fileChangesByStep: Map<string, FileChange[]> = new Map(),
): string {
  const meta = `<div class="meta-row">
    <div class="kv"><strong>Status</strong> <span class="pill ${esc(run.status)}">${esc(run.status)}</span></div>
    <div class="kv"><strong>Steps</strong> <span class="val">${run.step_count}</span></div>
    <div class="kv"><strong>Cost</strong> <span class="val">${costEl(run.cost_cents)}</span></div>
    <div class="kv"><strong>Input</strong> <span class="val">${run.tokens_total_input.toLocaleString()}</span></div>
    <div class="kv"><strong>Output</strong> <span class="val">${run.tokens_total_output.toLocaleString()}</span></div>
    <div class="kv"><strong>Cached</strong> <span class="val">${run.tokens_total_cached.toLocaleString()}</span></div>
    <div class="kv"><strong>Branch</strong> <span class="val">${esc(run.git_branch ?? "—")}</span></div>
    ${
      run.cwd
        ? `<div class="kv"><strong>Project</strong> <span class="val mono" title="${esc(run.cwd)}">${esc(projectLabel(run.cwd))}</span>
            <button class="copy-btn" title="copy full project path" onclick="copyText('${esc(run.cwd)}', this)">copy</button>
          </div>`
        : ""
    }
    <div class="kv"><strong>Run ID</strong> <span class="val mono">${esc(run.run_id.slice(0, 16))}…</span>
      <button class="copy-btn" title="copy full run id" onclick="copyText('${esc(run.run_id)}', this)">copy</button>
    </div>
    <div class="kv"><strong>Export</strong>
      <a class="val mono" href="/api/runs/${esc(run.run_id)}/export" download="${esc(run.run_id)}.spool.json"
         title="Download as Spool Trace Format v0.2 JSON (with inlined blobs)">trace.json</a>
      <a class="copy-btn" href="/api/runs/${esc(run.run_id)}/export?blobs=0" download="${esc(run.run_id)}.thin.json"
         title="Trace without inlined blobs (smaller)">thin</a>
    </div>
    ${run.fork_origin_run_id ? `<div class="kv"><strong>Forked from</strong> <a href="/runs/${esc(run.fork_origin_run_id)}">${esc(run.fork_origin_run_id.slice(0, 12))}</a></div>` : ""}
  </div>`;

  const timeline = `<div class="timeline">${steps
    .map((s) => {
      const label =
        s.action.kind === "tool_call"
          ? esc(s.action.tool_name ?? "tool")
          : s.action.kind === "message"
            ? "msg"
            : s.action.kind === "thinking_only"
              ? "•"
              : esc(s.action.kind);
      return `<div class="blk ${esc(s.status)}" data-seq="${s.sequence}" title="step ${s.sequence}: ${esc(s.action.kind)}${s.action.tool_name ? " " + esc(s.action.tool_name) : ""}" onclick="jumpToStep(${s.sequence})">${s.sequence}. ${label}</div>`;
    })
    .join("")}</div>`;

  const errorCount = steps.filter((s) => s.status === "error").length;
  const toolCount = steps.filter((s) => s.action.kind === "tool_call").length;
  const msgCount = steps.filter((s) => s.action.kind === "message").length;
  const filterBar = `<div class="filter-bar">
    <span class="filter-chip active" data-kind="all" onclick="applyFilter('all')">All · ${steps.length}</span>
    <span class="filter-chip" data-kind="tools" onclick="applyFilter('tools')">Tool calls · ${toolCount}</span>
    <span class="filter-chip" data-kind="messages" onclick="applyFilter('messages')">Messages · ${msgCount}</span>
    <span class="filter-chip" data-kind="errors" onclick="applyFilter('errors')">Errors · ${errorCount}</span>
    <input class="filter-input" id="step-filter" type="text"
      placeholder="filter by text (press / to focus)"
      oninput="applyTextFilter(this.value)">
    <span style="margin-left:auto;font-size:11px;color:var(--fg-mute)">
      <kbd>j</kbd>/<kbd>k</kbd> next/prev · <kbd>g</kbd>/<kbd>G</kbd> top/bottom · <kbd>?</kbd> help
    </span>
  </div>`;

  const runAnnotations = `<div class="step-card">
    <div class="section-label">Annotations</div>
    <h3 style="display:flex;align-items:center;gap:8px">
      <span>Run notes</span>
      <span class="row-actions" style="margin-left:auto">
        <button onclick="openAnnotateModal('run', '${esc(run.run_id)}')">+ Annotate</button>
      </span>
    </h3>
    ${annotations.length
      ? annotations
        .map(
          (a) =>
            `<div class="annotation"><strong>${esc(a.author)}</strong> · <em>${esc(a.verdict ?? "note")}</em> · ${esc(a.note ?? "")}</div>`,
        )
        .join("")
      : '<p style="color:var(--text-tertiary);font-size:12.5px;margin:0">No annotations yet.</p>'
    }
  </div>`;

  const forksBlock = forks.length
    ? `<div class="step-card">
        <div class="section-label">Forks</div>
        <h3>Derived runs</h3>
        ${forks
      .map(
        (f) =>
          `<div class="annotation"><span class="badge badge--premium">${esc(f.edit_type)}</span> from step <code>${esc(f.origin_step_id.slice(0, 12))}</code> → <a href="/runs/${esc(f.fork_run_id)}">${esc(f.fork_run_id.slice(0, 12))}</a> · <a href="/diff?a=${esc(run.run_id)}&b=${esc(f.fork_run_id)}">diff</a></div>`,
      )
      .join("")}
      </div>`
    : "";

  const stepCards = steps
    .map((s) =>
      renderStepCard(
        s,
        stepDecisions.get(s.step_id) ?? "",
        fileChangesByStep.get(s.step_id) ?? [],
      ),
    )
    .join("");

  // v0.3 §8.2 — "Files changed in this run" — collapsible summary
  // below the run header when any step touched a file. Per-path
  // cumulative stats with op badge and step count. Click a row to
  // jump to the most recent step that touched the path.
  const allFileChanges: FileChange[] = [];
  for (const list of fileChangesByStep.values()) {
    for (const fc of list) allFileChanges.push(fc);
  }
  const filesSection = renderRunFilesSummary(allFileChanges, steps);

  const runtimeLabel =
    run.source_runtime === "fork" ? "Fork" : run.source_runtime;
  // Seal control — only when the run is still in_progress. Status picker
  // tints itself by selection (mint/coral/amber) so the visual matches
  // what'll be written. The whole thing reads as one rounded segmented
  // control instead of two unrelated form elements.
  const closeButton =
    run.status === "in_progress"
      ? `<div class="seal-control" style="margin-left:auto"
            title="Seal this run — sets ended_at + final status. Useful for proxy-captured runs that have no upstream end signal.">
          <select class="seal-status-select"
            id="close-status-${esc(run.run_id)}"
            data-status="ok"
            onchange="this.dataset.status=this.value"
            aria-label="final status">
            <option value="ok">ok</option>
            <option value="error">error</option>
            <option value="abandoned">abandoned</option>
          </select>
          <button class="seal-action" type="button"
            onclick="closeRun('${esc(run.run_id)}', document.getElementById('close-status-${esc(run.run_id)}').value)">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Seal run
          </button>
        </div>`
      : "";
  // Stamp the <main> wrapper with the run id + current step count so
  // the live-updater JS knows which run is on screen and where to
  // resume the sequence walk. Plain inline script keeps it CSP-
  // friendly (no module loader needed).
  const liveStamp = `<script>
    (function () {
      var m = document.querySelector('main');
      if (!m) return;
      m.dataset.runId = ${JSON.stringify(run.run_id)};
      m.dataset.stepCount = ${JSON.stringify(String(steps.length))};
    })();
  </script>`;
  return `<div style="margin-bottom:var(--space-6)">
      <div class="section-label">${esc(runtimeLabel)} · Run</div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0">${esc(run.title ?? run.run_id)}</h2>
        ${closeButton}
      </div>
    </div>
    ${meta}
    ${timeline}
    ${filesSection}
    ${filterBar}
    ${runAnnotations}
    ${forksBlock}
    <div id="steps-anchor">${stepCards.length ? stepCards : `<div class="empty">No steps in this run.</div>`}</div>
    ${COST_FOOTNOTE_HTML}
    ${liveStamp}`;
}

/**
 * v0.3 — pre-rendered fragment for the live-append flow. Wraps a step
 * card + a detached timeline cell so the client can lift each into
 * the right place in one parse (look up `[data-timeline-blk]` inside
 * the wrapper and the rest goes to the steps anchor).
 *
 * Returning HTML instead of JSON keeps the rendering decisions
 * (mono path padding, tab order, op color, copy-button setup) in one
 * source of truth — server-side templates. The client JS stays a
 * thin appender.
 */
export function renderStepCardFragment(
  s: Step,
  decision: string,
  fileChanges: FileChange[] = [],
): string {
  const card = renderStepCard(s, decision, fileChanges);
  const tlColor =
    s.action.kind === "tool_call"
      ? esc(s.action.tool_name ?? "tool")
      : s.action.kind === "message"
        ? "msg"
        : s.action.kind === "thinking_only"
          ? "•"
          : esc(s.action.kind);
  const timelineBlk = `<div class="blk ${esc(s.status)}" data-seq="${s.sequence}" data-timeline-blk="1" title="step ${s.sequence}: ${esc(s.action.kind)}${s.action.tool_name ? " " + esc(s.action.tool_name) : ""}" onclick="jumpToStep(${s.sequence})">${s.sequence}. ${tlColor}</div>`;
  // Single wrapping element so the client can grab `firstElementChild`
  // for the card; the timeline block is picked up by selector.
  return `<div data-step-fragment="1">${card}${timelineBlk}</div>`;
}

function renderStepCard(
  s: Step,
  decision: string,
  fileChanges: FileChange[] = [],
): string {
  const status = `<span class="pill ${esc(s.status)}">${esc(s.status)}</span>`;
  const defaultText = s.action.kind === "message" ? (s.action.text ?? "").slice(0, 200) : "";
  const stepHeader = `<h3 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <a href="#step-${s.sequence}" onclick="jumpToStep(${s.sequence}); event.preventDefault();"
       style="color:var(--fg);text-decoration:none">#${s.sequence}</a>
    <span>· ${esc(s.action.kind)}${s.action.tool_name ? ` · <code>${esc(s.action.tool_name)}</code>` : ""}</span>
    ${status}
    <span class="pill">${esc(s.model)}</span>
    <button class="copy-btn" title="copy step id" onclick="copyText('${esc(s.step_id)}', this)">${esc(s.step_id.slice(0, 12))}</button>
    <span class="row-actions" style="margin-left:auto">
      <button onclick="openForkModal('${esc(s.run_id)}', ${s.sequence}, ${JSON.stringify(defaultText)})">Fork from here</button>
      <button onclick="openAnnotateModal('step', '${esc(s.step_id)}')">Annotate</button>
    </span>
  </h3>`;

  // v0.3 — Files tab only renders when the step actually captured
  // file changes. For read-only steps (Read/Glob/Grep/Task) we omit
  // it to keep the tab bar quiet.
  const hasFiles = fileChanges.length > 0;
  const filesTabBtn = hasFiles
    ? `<button class="tab-btn" data-tab="files" onclick="showTab('${esc(s.step_id)}','files')">Files <span class="tab-count">${fileChanges.length}</span></button>`
    : "";
  const tabBar = `<div class="tab-bar">
    <button class="tab-btn active" data-tab="decision" onclick="showTab('${esc(s.step_id)}','decision')">Decision</button>
    <button class="tab-btn" data-tab="action" onclick="showTab('${esc(s.step_id)}','action')">Action</button>
    <button class="tab-btn" data-tab="outcome" onclick="showTab('${esc(s.step_id)}','outcome')">Outcome</button>
    <button class="tab-btn" data-tab="cost" onclick="showTab('${esc(s.step_id)}','cost')">Cost</button>
    <button class="tab-btn" data-tab="context" onclick="showTab('${esc(s.step_id)}','context')">Context</button>
    ${filesTabBtn}
  </div>`;

  const decisionTab = `<div class="tab tab-decision"><pre class="body">${esc(prettyJson(decision))}</pre></div>`;
  const actionTab = `<div class="tab tab-action" style="display:none"><pre class="body">${esc(JSON.stringify(s.action, null, 2))}</pre></div>`;
  const outcomeTab = `<div class="tab tab-outcome" style="display:none"><pre class="body">${esc(JSON.stringify(s.outcome, null, 2))}</pre>${s.outcome.tool_result_ref
    ? `<p><a href="/api/blob/${esc(s.outcome.tool_result_ref)}" target="_blank">view tool result (${esc(s.outcome.tool_result_ref.slice(0, 12))})</a></p>`
    : ""
    }</div>`;
  const costTab = `<div class="tab tab-cost" style="display:none"><pre class="body">${esc(
    JSON.stringify(
      {
        model: s.model,
        tokens: s.tokens,
        latency_ms: s.latency_ms,
        cost_cents: s.cost_cents,
        tags: s.tags,
      },
      null,
      2,
    ),
  )}</pre></div>`;
  const contextTab = `<div class="tab tab-context" style="display:none">
    <p>
      <a href="/contexts/${esc(s.context_snapshot_id)}?run=${esc(s.run_id)}&step=${esc(s.step_id)}&seq=${s.sequence}" target="_blank">
        view full context
      </a>
      &nbsp;·&nbsp;
      <a href="/api/blob/${esc(s.context_snapshot_id)}" target="_blank" style="color:var(--text-tertiary);font-size:11px">
        raw manifest (${esc(s.context_snapshot_id.slice(0, 12))})
      </a>
    </p>
  </div>`;

  const filesTab = hasFiles
    ? `<div class="tab tab-files" style="display:none">${renderStepFilesPanel(fileChanges)}</div>`
    : "";

  return `<div class="step-card" id="step-${s.sequence}" data-step="${esc(s.step_id)}" data-step-seq="${s.sequence}" data-action-kind="${esc(s.action.kind)}" data-step-status="${esc(s.status)}">${stepHeader}${tabBar}${decisionTab}${actionTab}${outcomeTab}${costTab}${contextTab}${filesTab}</div>`;
}

/**
 * v0.3 — render the Files tab body for one step. Per row: op badge,
 * monospace path, +/- stats, flag chips, expandable unified diff.
 * Binary + redacted + partial all surface inline so the user always
 * knows what they're looking at.
 */
function renderStepFilesPanel(fcs: FileChange[]): string {
  const stats = fcs.reduce(
    (acc, fc) => ({
      added: acc.added + fc.lines_added,
      removed: acc.removed + fc.lines_removed,
    }),
    { added: 0, removed: 0 },
  );
  const header = `<div class="files-summary">
    <span class="files-stat-add">+${stats.added}</span>
    <span class="files-stat-rm">−${stats.removed}</span>
    <span class="files-stat-count">${fcs.length} file${fcs.length === 1 ? "" : "s"}</span>
  </div>`;
  const rows = fcs
    .map((fc, idx) => {
      const renderedPath =
        fc.op === "rename" && fc.old_path
          ? `${esc(fc.old_path)} → ${esc(fc.path)}`
          : esc(fc.path);
      const flags: string[] = [];
      if (fc.partial_diff) flags.push(`<span class="file-flag flag-partial">partial</span>`);
      if (fc.patch_format === "binary") flags.push(`<span class="file-flag flag-binary">binary</span>`);
      if (fc.redacted) flags.push(`<span class="file-flag flag-redacted">redacted</span>`);
      const expandable = !fc.partial_diff && !!fc.patch_text;
      const body = expandable
        ? `<pre class="file-diff" style="display:none">${renderColorizedPatch(fc.patch_text!)}</pre>`
        : fc.partial_diff
          ? `<div class="file-diff-empty">partial — this change ran outside captured tools (e.g. Bash). Enable <code>spool watch --files</code> in v0.4 for full fidelity.</div>`
          : fc.patch_format === "binary"
            ? `<div class="file-diff-empty">binary file — ${esc(fc.path)} (${fc.size_before ?? "?"} → ${fc.size_after ?? "?"} bytes). <a href="/api/blob/${esc(fc.after_blob_ref ?? "")}" target="_blank">raw bytes</a></div>`
            : "";
      const rowId = `fc-${esc(fc.file_change_id)}-${idx}`;
      return `<div class="file-row" data-op="${esc(fc.op)}">
        <button class="file-row-head${expandable ? " expandable" : ""}"
          ${expandable ? `onclick="toggleFileDiff('${rowId}')"` : ""}>
          <span class="file-op file-op-${esc(fc.op)}">${opLetter(fc.op)}</span>
          <span class="file-path mono">${renderedPath}</span>
          <span class="file-stats"><span class="files-stat-add">+${fc.lines_added}</span> <span class="files-stat-rm">−${fc.lines_removed}</span></span>
          ${flags.join(" ")}
          ${expandable ? `<span class="file-row-caret">▾</span>` : ""}
        </button>
        <div id="${rowId}">${body}</div>
      </div>`;
    })
    .join("");
  return `${header}<div class="file-list">${rows}</div>`;
}

/** Colorize a unified-diff patch into spans the file-diff CSS picks up. */
function renderColorizedPatch(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("@@"))
        return `<span class="diff-hunk">${esc(line)}</span>`;
      if (line.startsWith("+") && !line.startsWith("+++"))
        return `<span class="diff-add">${esc(line)}</span>`;
      if (line.startsWith("-") && !line.startsWith("---"))
        return `<span class="diff-del">${esc(line)}</span>`;
      return esc(line);
    })
    .join("\n");
}

function opLetter(op: FileOp): string {
  switch (op) {
    case "create": return "A";
    case "modify": return "M";
    case "delete": return "D";
    case "rename": return "R";
    case "chmod":  return "X";
  }
}

/**
 * v0.3 §8.2 — "Files changed in this run" summary card below the
 * run header. Collapses multiple changes to the same path into one
 * row (op letter = the *terminal* op for that path).
 */
function renderRunFilesSummary(fcs: FileChange[], steps: Step[]): string {
  if (fcs.length === 0) return "";
  // Build the collapsed view + count steps touching each path.
  const byPath = new Map<
    string,
    {
      path: string;
      terminalOp: FileOp;
      lines_added: number;
      lines_removed: number;
      rename_from?: string;
      any_partial: boolean;
      any_binary: boolean;
      step_ids: Set<string>;
    }
  >();
  for (const fc of fcs) {
    const cur = byPath.get(fc.path);
    if (cur) {
      cur.terminalOp = fc.op;
      cur.lines_added += fc.lines_added;
      cur.lines_removed += fc.lines_removed;
      cur.any_partial = cur.any_partial || fc.partial_diff;
      cur.any_binary = cur.any_binary || fc.patch_format === "binary";
      cur.step_ids.add(fc.step_id);
      if (fc.op === "rename" && fc.old_path) cur.rename_from = fc.old_path;
    } else {
      byPath.set(fc.path, {
        path: fc.path,
        terminalOp: fc.op,
        lines_added: fc.lines_added,
        lines_removed: fc.lines_removed,
        rename_from: fc.op === "rename" ? fc.old_path : undefined,
        any_partial: fc.partial_diff,
        any_binary: fc.patch_format === "binary",
        step_ids: new Set([fc.step_id]),
      });
    }
  }
  const rows = [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const totalAdded = rows.reduce((n, r) => n + r.lines_added, 0);
  const totalRemoved = rows.reduce((n, r) => n + r.lines_removed, 0);
  // Find each path's most recent touch (by step.sequence) so the "jump
  // to last touch" click target is meaningful.
  const seqByStepId = new Map<string, number>();
  for (const s of steps) seqByStepId.set(s.step_id, s.sequence);
  return `<details class="run-files-summary" open>
    <summary>
      <span class="section-label">Files changed in this run</span>
      <span class="run-files-totals">
        <span class="files-stat-add">+${totalAdded}</span>
        <span class="files-stat-rm">−${totalRemoved}</span>
        <span class="files-stat-count">${rows.length} file${rows.length === 1 ? "" : "s"}</span>
      </span>
    </summary>
    <div class="run-files-list">
      ${rows
        .map((r) => {
          const lastSeq = Math.max(
            0,
            ...[...r.step_ids].map((id) => seqByStepId.get(id) ?? 0),
          );
          const renderedPath =
            r.terminalOp === "rename" && r.rename_from
              ? `${esc(r.rename_from)} → ${esc(r.path)}`
              : esc(r.path);
          const flags: string[] = [];
          if (r.any_partial) flags.push(`<span class="file-flag flag-partial">partial</span>`);
          if (r.any_binary) flags.push(`<span class="file-flag flag-binary">binary</span>`);
          return `<button class="run-file-row" data-op="${esc(r.terminalOp)}"
              onclick="jumpToStep(${lastSeq})"
              title="jump to step #${lastSeq} (last touch of ${esc(r.path)})">
            <span class="file-op file-op-${esc(r.terminalOp)}">${opLetter(r.terminalOp)}</span>
            <span class="file-path mono">${renderedPath}</span>
            <span class="file-stats">
              <span class="files-stat-add">+${r.lines_added}</span>
              <span class="files-stat-rm">−${r.lines_removed}</span>
            </span>
            <span class="run-file-row-meta">${r.step_ids.size} step${r.step_ids.size === 1 ? "" : "s"}</span>
            ${flags.join(" ")}
          </button>`;
        })
        .join("")}
    </div>
  </details>`;
}

function prettyJson(maybeJson: string): string {
  try {
    const obj = JSON.parse(maybeJson);
    return JSON.stringify(obj, null, 2);
  } catch {
    return maybeJson;
  }
}

export interface DiffRenderOptions {
  showShared?: boolean;
}

export function renderDiff(
  a: Run,
  b: Run,
  d: DiffResult,
  opts: DiffRenderOptions = {},
): string {
  const showShared = opts.showShared === true;
  const sharedHidden = d.rows.filter((r) => r.kind === "shared").length;
  const header = `<div style="margin-bottom:var(--space-5)">
      <div class="section-label">Trajectory diff</div>
      <h2 style="margin:0">${esc(a.title ?? a.run_id.slice(0, 12))} <span style="color:var(--text-tertiary);font-weight:400">vs</span> ${esc(b.title ?? b.run_id.slice(0, 12))}</h2>
    </div>
    <div class="meta-row">
      <div class="kv"><strong>Shared prefix</strong> <span class="val">${d.shared_prefix_length} steps</span></div>
      <div class="kv"><strong>First divergence</strong> <span class="val">${d.first_divergence_sequence ?? "—"}</span></div>
      <div class="kv"><strong>Total A / B</strong> <span class="val">${d.total_steps_a} / ${d.total_steps_b}</span></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
      <a href="/diff?a=${esc(a.run_id)}&b=${esc(b.run_id)}${showShared ? "" : "&shared=1"}"
         class="${showShared ? "primary" : ""}"
         style="padding:6px 12px;border:1px solid var(--border);border-radius:4px;text-decoration:none;font-size:12px;${showShared ? "background:var(--accent);color:#0e1116;border-color:var(--accent)" : "color:var(--fg)"}">
        ${showShared ? "✓ Showing shared rows" : `Show shared rows (${sharedHidden} hidden)`}
      </a>
      <a href="/api/diff?a=${esc(a.run_id)}&b=${esc(b.run_id)}"
         download="diff-${esc(a.run_id.slice(0, 8))}-${esc(b.run_id.slice(0, 8))}.json"
         style="padding:6px 12px;border:1px solid var(--border);border-radius:4px;text-decoration:none;font-size:12px;color:var(--fg);font-family:ui-monospace,Menlo,monospace">
        Download JSON
      </a>
    </div>`;
  const rows = d.rows
    .filter((r) => showShared || r.kind !== "shared")
    .map((row) => {
      const a = row.a
        ? `${row.a.action_kind}${row.a.tool_name ? "(" + esc(row.a.tool_name) + ")" : ""} · <span class="pill ${esc(row.a.outcome_status)}">${esc(row.a.outcome_status)}</span>`
        : "—";
      const b = row.b
        ? `${row.b.action_kind}${row.b.tool_name ? "(" + esc(row.b.tool_name) + ")" : ""} · <span class="pill ${esc(row.b.outcome_status)}">${esc(row.b.outcome_status)}</span>`
        : "—";
      return `<tr class="diff-row ${esc(row.kind)}">
        <td>${row.sequence}</td>
        <td><span class="pill">${esc(row.kind)}</span></td>
        <td>${a}</td>
        <td>${b}</td>
      </tr>`;
    })
    .join("");
  return `${header}
    <table>
      <thead><tr><th>Seq</th><th>Kind</th><th>A: ${esc(a.run_id.slice(0, 12))}</th><th>B: ${esc(b.run_id.slice(0, 12))}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function renderTests(tests: RegressionTest[], recent: RegressionResult[]): string {
  const items = tests.length
    ? tests
      .map(
        (t) =>
          `<a class="item" data-name="${esc(t.name)}" onclick="selectTest('${esc(t.name)}')">
              <div>${esc(t.name)}</div>
              <div class="meta">${t.assertions.length} assertions${t.canonical_run_id ? ` · canon ${esc(t.canonical_run_id.slice(0, 12))}` : ""}</div>
            </a>`,
      )
      .join("")
    : `<p style="color:var(--fg-mute);font-size:12.5px;padding:8px">No tests yet.</p>`;

  const recentRows = recent.length
    ? recent
      .map(
        (r) =>
          `<div class="row ${r.passed ? "pass" : "fail"}">
              ${r.passed ? "PASS" : "FAIL"}  ${esc(r.test_name.padEnd(20))}  ${esc(r.run_id.slice(0, 12))}  ${esc(r.created_at)}
            </div>`,
      )
      .join("")
    : `<p style="color:var(--fg-mute);font-size:12px">No results yet — pick a test and click "Run on all runs."</p>`;

  return `<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:var(--space-5)">
    <div>
      <div class="section-label">Regression suite</div>
      <h2 style="margin:0">Tests</h2>
    </div>
    <button class="primary" onclick="createNewTest()">+ New test</button>
  </div>
  <div class="tests-grid">
    <div class="test-list">${items}</div>
    <div id="test-detail" class="test-detail">
      <div class="empty">Select a test from the left to edit, or create a new one.</div>
    </div>
  </div>
  <div style="margin-top:var(--space-6)">
    <div class="section-label">Recent results · all tests</div>
    <div class="results-list">${recentRows}</div>
  </div>`;
}

/** Render a cost figure with the API-metered marker + tooltip. */
function costEl(cents: number): string {
  return `${costStr(cents)}<span class="cost-mark" title="Spool computes cost from token counts × Anthropic public per-token API rates. Two caveats: (1) Claude Pro/Max users pay a flat subscription — this is API-equivalent, NOT money out of your account. (2) Current API rates reflect VC-subsidized 2026 frontier-model economics: they cover inference with margin, but training runs (>$1B per Opus-class model) and cluster CapEx are funded by equity, not per-token revenue. If labs ever have to be cash-flow positive on a fully-loaded basis, expect these numbers to rise. Use for relative comparison between runs.">api·metered</span>`;
}
/**
 * Format a cost (stored in cents) as dollars. Uses 2 decimal places for
 * anything ≥ half a cent so the common case reads like a normal price,
 * and bumps to 4 decimals for sub-cent costs so they don't all collapse
 * to "$0.00". Always shows the dollar sign so the UI never mixes units.
 */
function costStr(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0.00";
  if (Math.abs(dollars) >= 0.005) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(4)}`;
}

const COST_FOOTNOTE_HTML = `<div class="cost-footnote">
  <span class="label">Pricing</span>
  Costs are token counts × Anthropic's public per-token API rates
  (Opus 4.x: $15/$75 input/output, $1.50 cached read, $18.75 5m / $30 1h cache write per million).
  <br><br>
  <strong>Two things this number is not.</strong>
  (1) If you're on Claude Pro or Max, you pay a flat subscription —
  this is the API-equivalent rate, <em>not</em> money out of your account.
  (2) The API rate itself reflects 2026 frontier-model economics: it covers
  inference with positive gross margin, but training runs (>$1B per Opus-class model),
  R&amp;D, and cluster CapEx are funded by VC equity rounds, not per-token revenue.
  If labs ever have to be cash-flow positive on a fully-loaded basis,
  expect these numbers to rise — possibly 2–4×.
  <br><br>
  Useful for <em>relative</em> comparison between runs (this prompt vs. that prompt,
  this iteration vs. the canonical), not as a forecast of long-run cost.
</div>`;

/**
 * Render a full context snapshot — resolves every content_ref into the
 * actual text the model saw, and renders by component type. The raw
 * snapshot JSON is just a manifest of SHA256 pointers; this page is
 * what you actually want when you click "view context."
 *
 * Caller passes the resolved {@link RenderedContext} (already loaded
 * blobs in memory) so this function stays pure / async-free.
 */
export function renderContext(
  snapshotId: string,
  ctx: RenderedContext,
  meta: { runId?: string; stepId?: string; sequence?: number } = {},
): string {
  const header = `<div style="margin-bottom:var(--space-6)">
    <div class="section-label">Context snapshot</div>
    <h2 style="margin:0">What the model saw${
      meta.sequence !== undefined ? ` at step #${meta.sequence}` : ""
    }</h2>
    <div class="meta-row" style="margin-top:var(--space-3)">
      <div class="kv"><strong>Snapshot</strong> <span class="val mono">${esc(snapshotId.slice(0, 16))}…</span>
        <button class="copy-btn" onclick="copyText('${esc(snapshotId)}', this)">copy</button>
      </div>
      ${
        meta.runId
          ? `<div class="kv"><strong>Run</strong> <a class="val mono" href="/runs/${esc(meta.runId)}">${esc(meta.runId.slice(0, 16))}</a></div>`
          : ""
      }
      ${
        meta.stepId
          ? `<div class="kv"><strong>Step</strong> <span class="val mono">${esc(meta.stepId.slice(0, 16))}…</span></div>`
          : ""
      }
      <div class="kv"><strong>Components</strong> <span class="val">${ctx.components.length}</span></div>
      <div class="kv"><strong>Total chars</strong> <span class="val">${ctx.totalChars.toLocaleString()}</span></div>
    </div>
  </div>`;

  if (ctx.components.length === 0) {
    return (
      header +
      `<div class="empty">This snapshot has no captured components.<br>
       Note: Claude Code captures don't include the system prompt or tool definitions —
       only what's visible in <code>~/.claude/projects/&lt;cwd&gt;/&lt;session&gt;.jsonl</code>.</div>`
    );
  }

  const blocks = ctx.components.map((c) => renderContextComponent(c)).join("");

  const fidelityNote =
    ctx.runtime === "claude-code"
      ? `<div class="static-banner" style="margin-top:var(--space-6)">
           <strong>Note on fidelity.</strong> Spool captures what Claude Code writes
           to its session log: conversation history. The system prompt, tool definitions,
           and any RAG context Anthropic injects server-side aren't in the log and
           aren't shown here. SDK-captured runs (<code>@spool/agent</code>) carry the
           full context.
         </div>`
      : "";

  return header + blocks + fidelityNote;
}

export interface RenderedContext {
  components: RenderedComponent[];
  totalChars: number;
  runtime?: string;
}

export type RenderedComponent =
  | { type: "system_prompt"; ref: string; text: string }
  | { type: "tool_definitions"; ref: string; text: string }
  | {
      type: "conversation_history";
      messages: Array<{
        role: "user" | "assistant" | "tool";
        ref: string;
        text: string;
        step_ref?: string;
      }>;
    }
  | {
      type: "retrieved_documents";
      docs: Array<{ source: string; ref: string; text: string }>;
    }
  | {
      type: "compaction_summary";
      ref: string;
      text: string;
      replaces_steps: string[];
    };

function renderContextComponent(c: RenderedComponent): string {
  switch (c.type) {
    case "system_prompt":
      return `<div class="step-card">
        <div class="section-label">System prompt</div>
        <h3 style="display:flex;align-items:baseline;gap:8px">
          <span>${c.text.length.toLocaleString()} chars</span>
          <button class="copy-btn" onclick="copyText('${esc(c.ref)}', this)">${esc(c.ref.slice(0, 12))}</button>
        </h3>
        <pre class="body">${esc(c.text)}</pre>
      </div>`;

    case "tool_definitions":
      return `<div class="step-card">
        <div class="section-label">Tool definitions</div>
        <h3>${c.text.length.toLocaleString()} chars</h3>
        <pre class="body">${esc(prettyJsonMaybe(c.text))}</pre>
      </div>`;

    case "conversation_history":
      return `<div class="step-card">
        <div class="section-label">Conversation history · ${c.messages.length} turn${c.messages.length === 1 ? "" : "s"}</div>
        <h3>Messages</h3>
        ${c.messages
          .map(
            (m, i) =>
              `<div class="annotation" style="border-left-color:${roleColor(m.role)}">
                <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
                  <span class="badge ${roleBadgeClass(m.role)}">${esc(m.role.toUpperCase())}</span>
                  <span style="color:var(--text-tertiary);font-size:11px;font-family:var(--font-mono)">#${i} · ${m.text.length.toLocaleString()} chars</span>
                  <button class="copy-btn" style="margin-left:auto" onclick="copyText('${esc(m.ref)}', this)">${esc(m.ref.slice(0, 12))}</button>
                </div>
                <pre class="body" style="margin:0">${esc(m.text)}</pre>
              </div>`,
          )
          .join("")}
      </div>`;

    case "retrieved_documents":
      return `<div class="step-card">
        <div class="section-label">Retrieved documents · ${c.docs.length}</div>
        <h3>RAG context</h3>
        ${c.docs
          .map(
            (d) =>
              `<div class="annotation">
                <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
                  <strong>${esc(d.source)}</strong>
                  <span style="color:var(--text-tertiary);font-size:11px">${d.text.length.toLocaleString()} chars</span>
                </div>
                <pre class="body" style="margin:0">${esc(d.text)}</pre>
              </div>`,
          )
          .join("")}
      </div>`;

    case "compaction_summary":
      return `<div class="step-card">
        <div class="section-label">Compaction summary</div>
        <h3>Replaces ${c.replaces_steps.length} step${c.replaces_steps.length === 1 ? "" : "s"}</h3>
        <pre class="body">${esc(c.text)}</pre>
      </div>`;
  }
}

function roleColor(role: string): string {
  switch (role) {
    case "user":
      return "var(--cerulean-400)";
    case "assistant":
      return "var(--mint-400)";
    case "tool":
      return "var(--amber-400)";
    default:
      return "var(--border-default)";
  }
}
function roleBadgeClass(role: string): string {
  switch (role) {
    case "user":
      return "badge--info";
    case "assistant":
      return "badge--success";
    case "tool":
      return "badge--warn";
    default:
      return "badge--muted";
  }
}
function prettyJsonMaybe(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

export interface SettingsPageData {
  slackWebhook?: string;
  slackWebhookFromEnv: boolean;
  apiKey?: string;
  apiKeyFromEnv: boolean;
  postgresUrl?: string;
  postgresUrlFromEnv: boolean;
  watchedTools: string;
  stallSeconds: number;
  defaultModel: string;
  defaultMaxIterations: number;
}

/**
 * Settings page. Five sections — Ingest, Doctor, Slack, Postgres,
 * Capture defaults. Each section is a card with inline forms that
 * POST to /api/* endpoints. Settings persist in the SQLite settings
 * table; secrets are stored in plaintext (web UI is local-only) with
 * a clear disclosure.
 */
export function renderSettings(data: SettingsPageData): string {
  const slackVal = data.slackWebhookFromEnv
    ? "(from $SPOOL_SLACK_WEBHOOK)"
    : data.slackWebhook ?? "";
  const apiKeyDisplay = data.apiKeyFromEnv
    ? "(from $ANTHROPIC_API_KEY)"
    : data.apiKey
      ? "•".repeat(48)
      : "";
  const pgVal = data.postgresUrlFromEnv
    ? "(from $SPOOL_DB_URL)"
    : data.postgresUrl ?? "";

  return `<div style="margin-bottom:24px">
    <div class="section-label">Configuration</div>
    <h2 style="margin:0">Settings</h2>
    <div style="font-size:12.5px;color:var(--fg-mute);margin-top:6px">
      Stored in <code>$SPOOL_HOME/spool.db</code>. Environment variables override stored values.
    </div>
  </div>

  ${/* ─── Ingest ──────────────────────────── */ ""}
  <div class="step-card">
    <div class="section-label">Ingest</div>
    <h3 style="margin-bottom:8px">Capture sessions from disk</h3>
    <p style="color:var(--fg-mute);font-size:12.5px;margin:0 0 12px">
      Replaces <code>spool ingest claude-code/codex-cli/cursor</code> from the terminal.
    </p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--fg-mute)">
        Limit
        <input type="number" id="ingest-limit" value="5" min="1" max="500" style="width:70px">
      </label>
      <button class="primary" onclick="runIngest('claude-code')">Ingest Claude Code</button>
      <button onclick="runIngest('codex-cli')">Ingest Codex</button>
      <button onclick="runIngest('cursor')">Ingest Cursor</button>
      <span id="ingest-status" style="margin-left:8px;font-size:12px;color:var(--fg-mute);font-family:ui-monospace,Menlo,monospace"></span>
    </div>
  </div>

  ${/* ─── Doctor ──────────────────────────── */ ""}
  <div class="step-card">
    <div class="section-label">Health</div>
    <h3 style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span>Doctor</span>
      <span class="row-actions" style="margin-left:auto">
        <button onclick="runDoctor()">Run checks</button>
      </span>
    </h3>
    <p style="color:var(--fg-mute);font-size:12.5px;margin:0 0 12px">
      Equivalent to <code>spool doctor</code>: Node version, capture surface, store integrity.
    </p>
    <div id="doctor-results" style="font-family:ui-monospace,Menlo,monospace;font-size:12px"></div>
  </div>

  ${/* ─── Slack ──────────────────────────── */ ""}
  <div class="step-card">
    <div class="section-label">Notifications</div>
    <h3 style="margin-bottom:8px">Slack webhook</h3>
    <p style="color:var(--fg-mute);font-size:12.5px;margin:0 0 12px">
      Routes live alerts (loop / stall / context-threshold / tool-watched) to Slack.
      Take an Incoming Webhook URL from your Slack workspace.
    </p>
    <div style="display:flex;gap:8px;align-items:center">
      <input id="slack-webhook" type="password"
        placeholder="https://hooks.slack.com/services/..."
        value="${esc(slackVal)}"
        ${data.slackWebhookFromEnv ? "disabled" : ""}
        style="flex:1;font-family:ui-monospace,Menlo,monospace">
      ${
        data.slackWebhookFromEnv
          ? `<span class="badge" style="opacity:0.8">env</span>`
          : `<button class="primary" onclick="saveSetting('slack.webhook', document.getElementById('slack-webhook').value, 'slack-status')">Save</button>
             <button onclick="testSlack()">Test</button>`
      }
    </div>
    <p id="slack-status" style="font-size:12px;color:var(--fg-mute);margin-top:8px;font-family:ui-monospace,Menlo,monospace"></p>
  </div>

  ${/* ─── Anthropic API key ──────────────── */ ""}
  <div class="step-card">
    <div class="section-label">Anthropic</div>
    <h3 style="margin-bottom:8px">API key (for live fork suffix)</h3>
    <p style="color:var(--fg-mute);font-size:12.5px;margin:0 0 12px">
      Required when using <strong>Live</strong> mode in the Fork modal or <strong>Continue: live</strong> for multi-step replay.
      Stored unencrypted in the local SQLite store.
    </p>
    <div style="display:flex;gap:8px;align-items:center">
      <input id="anthropic-key" type="password"
        placeholder="sk-ant-..."
        value="${esc(apiKeyDisplay)}"
        ${data.apiKeyFromEnv ? "disabled" : ""}
        style="flex:1;font-family:ui-monospace,Menlo,monospace">
      ${
        data.apiKeyFromEnv
          ? `<span class="badge" style="opacity:0.8">env</span>`
          : `<button class="primary" onclick="saveSetting('anthropic.api_key', document.getElementById('anthropic-key').value, 'apikey-status')">Save</button>`
      }
    </div>
    <p id="apikey-status" style="font-size:12px;color:var(--fg-mute);margin-top:8px;font-family:ui-monospace,Menlo,monospace"></p>
  </div>

  ${/* ─── Postgres ──────────────────────── */ ""}
  <div class="step-card">
    <div class="section-label">Hosted backend (optional)</div>
    <h3 style="margin-bottom:8px">Postgres</h3>
    <p style="color:var(--fg-mute);font-size:12.5px;margin:0 0 12px">
      Replicate captured runs to Postgres for the team tier (SPEC §15.3). One-way sync; local SQLite remains primary.
    </p>
    <div style="display:flex;gap:8px;align-items:center">
      <input id="pg-url" type="password"
        placeholder="postgres://user:pass@host:5432/spool"
        value="${esc(pgVal)}"
        ${data.postgresUrlFromEnv ? "disabled" : ""}
        style="flex:1;font-family:ui-monospace,Menlo,monospace">
      ${
        data.postgresUrlFromEnv
          ? `<span class="badge" style="opacity:0.8">env</span>`
          : `<button class="primary" onclick="saveSetting('postgres.url', document.getElementById('pg-url').value, 'pg-status')">Save</button>`
      }
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button onclick="postgresInit()">Init schema</button>
      <button onclick="postgresSync()">Sync now</button>
    </div>
    <p id="pg-status" style="font-size:12px;color:var(--fg-mute);margin-top:8px;font-family:ui-monospace,Menlo,monospace"></p>
  </div>

  ${/* ─── Capture defaults ──────────────── */ ""}
  <div class="step-card">
    <div class="section-label">Capture defaults</div>
    <h3 style="margin-bottom:12px">Live + fork preferences</h3>
    <div class="grid-2" style="gap:16px">
      <label style="font-size:12px;color:var(--fg-mute);display:flex;flex-direction:column;gap:4px">
        Watched tools (comma-separated, fires alerts when called)
        <input id="watch-tools" value="${esc(data.watchedTools)}" placeholder="Bash, Write" style="font-family:ui-monospace,Menlo,monospace">
      </label>
      <label style="font-size:12px;color:var(--fg-mute);display:flex;flex-direction:column;gap:4px">
        Stall threshold (seconds)
        <input id="stall-seconds" type="number" min="10" max="3600" value="${data.stallSeconds}">
      </label>
      <label style="font-size:12px;color:var(--fg-mute);display:flex;flex-direction:column;gap:4px">
        Default fork model
        <input id="default-model" value="${esc(data.defaultModel)}" style="font-family:ui-monospace,Menlo,monospace">
      </label>
      <label style="font-size:12px;color:var(--fg-mute);display:flex;flex-direction:column;gap:4px">
        Default max iterations (multi-step continuation)
        <input id="default-max-iter" type="number" min="1" max="100" value="${data.defaultMaxIterations}">
      </label>
    </div>
    <div style="margin-top:14px;display:flex;gap:8px">
      <button class="primary" onclick="saveDefaults()">Save defaults</button>
    </div>
    <p id="defaults-status" style="font-size:12px;color:var(--fg-mute);margin-top:8px;font-family:ui-monospace,Menlo,monospace"></p>
  </div>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
