import type { Annotation, Run, Step } from "@spool/shared";
import type { DiffResult } from "./diff.ts";
import type { FleetEntry } from "./live.ts";

/**
 * Server-rendered HTML. Single bundle of styles + tiny vanilla JS for
 * interactivity. v0 is deliberately framework-free — Spool's web UI
 * needs to feel like a DevTools panel, and a single-file render is
 * fastest to iterate on.
 */

const STYLES = `
  :root {
    --bg: #0e1116;
    --bg-2: #161b22;
    --bg-3: #1f2630;
    --border: #2a323d;
    --fg: #e6edf3;
    --fg-mute: #8b949e;
    --accent: #58a6ff;
    --ok: #3fb950;
    --warn: #d29922;
    --err: #f85149;
    --fork: #bc8cff;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
                 "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--fg);
    font-size: 14px; line-height: 1.5;
  }
  code, pre, .mono {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco,
                 Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 12.5px;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header {
    padding: 12px 20px; border-bottom: 1px solid var(--border);
    background: var(--bg-2);
    display: flex; align-items: center; gap: 16px;
    position: sticky; top: 0; z-index: 10;
  }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  header .crumbs { color: var(--fg-mute); font-size: 13px; }
  main { padding: 20px; max-width: 1500px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left; padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  th { color: var(--fg-mute); font-weight: 500; font-size: 12px;
       text-transform: uppercase; letter-spacing: 0.04em; }
  tr:hover td { background: var(--bg-2); }
  .pill {
    display: inline-block; padding: 1px 6px; border-radius: 4px;
    font-size: 11px; background: var(--bg-3); color: var(--fg-mute);
    border: 1px solid var(--border);
  }
  .pill.ok { color: var(--ok); border-color: rgba(63,185,80,0.35); }
  .pill.error { color: var(--err); border-color: rgba(248,81,73,0.35); }
  .pill.in_progress { color: var(--warn); border-color: rgba(210,153,34,0.35); }
  .pill.abandoned { color: var(--fg-mute); }
  .pill.fork { color: var(--fork); border-color: rgba(188,140,255,0.4); }
  .timeline {
    display: flex; flex-wrap: wrap; gap: 3px;
    background: var(--bg-2); padding: 12px; border: 1px solid var(--border);
    border-radius: 6px; margin-bottom: 20px;
  }
  .timeline .blk {
    min-width: 18px; height: 24px; padding: 2px 5px;
    border-radius: 3px; background: var(--bg-3);
    font-size: 11px; color: var(--fg-mute);
    border: 1px solid var(--border);
    cursor: pointer; user-select: none;
  }
  .timeline .blk.ok { border-color: rgba(63,185,80,0.5); color: var(--fg); }
  .timeline .blk.error { background: rgba(248,81,73,0.18); border-color: var(--err); color: var(--err); }
  .timeline .blk.in_progress { border-color: rgba(210,153,34,0.5); color: var(--warn); }
  .timeline .blk.active { outline: 2px solid var(--accent); }
  .step-card {
    background: var(--bg-2); border: 1px solid var(--border);
    border-radius: 6px; padding: 14px 16px; margin-bottom: 12px;
  }
  .step-card h3 { margin: 0 0 8px 0; font-size: 14px; font-weight: 600; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  pre.body {
    background: var(--bg); border: 1px solid var(--border);
    padding: 10px; border-radius: 4px; max-height: 360px;
    overflow: auto; white-space: pre-wrap; word-break: break-word;
  }
  .tab-bar { display: flex; gap: 4px; margin-bottom: 8px; }
  .tab-bar button {
    background: var(--bg-3); color: var(--fg-mute);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 4px 10px; cursor: pointer; font-size: 12px;
  }
  .tab-bar button.active { color: var(--fg); background: var(--bg-2); }
  .meta-row {
    display: flex; gap: 10px; flex-wrap: wrap;
    font-size: 12px; color: var(--fg-mute);
    margin-bottom: 12px;
  }
  .meta-row .kv strong { color: var(--fg); font-weight: 500; }
  .annotation {
    background: rgba(88,166,255,0.07); border-left: 2px solid var(--accent);
    padding: 6px 10px; margin: 6px 0; border-radius: 0 3px 3px 0;
    font-size: 12.5px;
  }
  .diff-row td { padding: 10px; }
  .diff-row.shared { opacity: 0.6; }
  .diff-row.context_diff td:nth-child(1) { border-left: 2px solid var(--warn); }
  .diff-row.decision_diff td:nth-child(1) { border-left: 2px solid var(--accent); }
  .diff-row.action_diff td:nth-child(1) { border-left: 2px solid var(--err); }
  .diff-row.outcome_diff td:nth-child(1) { border-left: 2px solid var(--fork); }
  .diff-row.only_a td:nth-child(1) { border-left: 2px solid var(--err); }
  .diff-row.only_b td:nth-child(1) { border-left: 2px solid var(--ok); }
  .diff-row.diverged td:nth-child(1) { border-left: 2px solid var(--fork); }
  .empty { color: var(--fg-mute); font-style: italic; padding: 20px; }

  .fleet { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
  .card {
    background: var(--bg-2); border: 1px solid var(--border);
    border-radius: 6px; padding: 12px 14px;
  }
  .card .title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 8px; }
  .card .title-row .title { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .meta { font-size: 11.5px; color: var(--fg-mute); display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
  .card .meta .age { font-variant-numeric: tabular-nums; }
  .ctx-bar {
    height: 4px; background: var(--bg-3); border-radius: 2px;
    margin: 6px 0; position: relative; overflow: hidden;
  }
  .ctx-bar .fill { height: 100%; background: var(--accent); transition: width 0.4s; }
  .ctx-bar.warn .fill { background: var(--warn); }
  .ctx-bar.danger .fill { background: var(--err); }
  .recent-tools { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: var(--fg-mute); }
  .recent-tools code {
    background: var(--bg-3); padding: 1px 4px; border-radius: 3px; margin-right: 3px;
  }
  .alert-strip {
    margin-top: 6px; padding: 4px 8px; border-radius: 3px; font-size: 11.5px;
    background: rgba(248, 81, 73, 0.12); color: var(--err); border: 1px solid rgba(248,81,73,0.3);
  }
  .alert-strip.warn { background: rgba(210,153,34,0.12); color: var(--warn); border-color: rgba(210,153,34,0.3); }
  .pill.live-progressing { color: var(--ok); border-color: rgba(63,185,80,0.4); }
  .pill.live-stalled { color: var(--warn); border-color: rgba(210,153,34,0.4); }
  .pill.live-looping { color: var(--err); border-color: rgba(248,81,73,0.5); }
  .pill.live-awaiting_input { color: var(--accent); border-color: rgba(88,166,255,0.4); }
  .pill.live-errored { color: var(--err); border-color: rgba(248,81,73,0.5); }
  .pill.live-completed { color: var(--fg-mute); }
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
    +   '<span class="kv">$' + (r.cost_cents / 100).toFixed(2) + '</span>'
    +   '<span class="kv">' + escapeHtml(r.git_branch || '') + '</span>'
    +   '<span class="age" data-age="' + escapeHtml(e.last_step_at || '') + '">' + fmtAge(e.last_step_at) + '</span>'
    + '</div>'
    + '<div class="' + ctxBarClass(e.context_pct) + '" title="context util ' + e.context_pct + '%"><div class="fill" style="width:' + e.context_pct + '%"></div></div>'
    + '<div class="recent-tools">' + (tools || '<span style="opacity:0.5">no tools yet</span>') + '</div>'
    + alerts
    + '</div>';
}
function tickAges() {
  document.querySelectorAll('[data-age]').forEach(el => {
    el.textContent = fmtAge(el.dataset.age);
  });
}
function startLive() {
  if (typeof EventSource === 'undefined') return;
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
  setInterval(tickAges, 1000);
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
function jumpToStep(seq) {
  const target = document.querySelector('[data-seq="' + seq + '"]');
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelectorAll('.blk').forEach(b => b.classList.remove('active'));
  const blk = document.querySelector('.blk[data-seq="' + seq + '"]');
  if (blk) blk.classList.add('active');
}
`;

export function renderShell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)} · Spool</title>
<style>${STYLES}</style>
</head><body>
<header>
  <h1><a href="/">Spool</a></h1>
  <span class="crumbs">${esc(title)}</span>
</header>
<main>${body}</main>
<script>${SCRIPT}</script>
</body></html>`;
}

export function renderFleet(entries: FleetEntry[]): string {
  const initial = entries
    .map((e) => fleetEntryHtml(e))
    .join("");
  return `<div id="alert-banner" style="margin-bottom:12px"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="margin:0">Fleet</h2>
      <div class="meta-row" style="margin:0">
        <span class="kv"><strong>${entries.length}</strong> run(s) tracked</span>
        <span class="kv"><a href="/runs">all runs →</a></span>
      </div>
    </div>
    <div id="fleet-grid" class="fleet">${initial || `<div class="empty">No active runs yet. Open a Claude Code session and Spool will pick it up within a couple of seconds.</div>`}</div>`;
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
      <span class="kv">$${(r.cost_cents / 100).toFixed(2)}</span>
      <span class="kv">${esc(r.git_branch ?? "")}</span>
      <span class="age" data-age="${esc(e.last_step_at ?? "")}"></span>
    </div>
    <div class="${barClass}" title="context util ${e.context_pct}%"><div class="fill" style="width:${e.context_pct}%"></div></div>
    <div class="recent-tools">${tools || '<span style="opacity:0.5">no tools yet</span>'}</div>
    ${alerts}
  </div>`;
}

export function renderRunList(runs: Run[]): string {
  if (runs.length === 0) {
    return `<div class="empty">No runs captured yet. Run <code>spool ingest claude-code</code> to import sessions.</div>`;
  }
  const rows = runs
    .map((r) => {
      const status = `<span class="pill ${esc(r.status)}">${esc(r.status)}</span>`;
      const fork = r.fork_origin_run_id
        ? ` <span class="pill fork">fork</span>`
        : "";
      const cost = `${(r.cost_cents / 100).toFixed(2)}$`;
      const title = r.title ?? r.run_id;
      return `<tr>
        <td><a href="/runs/${esc(r.run_id)}">${esc(title)}</a>${fork}</td>
        <td>${status}</td>
        <td class="mono">${esc(r.run_id.slice(0, 12))}</td>
        <td>${r.step_count}</td>
        <td>${cost}</td>
        <td class="mono">${esc(r.started_at)}</td>
        <td class="mono">${esc(r.git_branch ?? "")}</td>
      </tr>`;
    })
    .join("");
  return `<table>
    <thead><tr>
      <th>Title</th><th>Status</th><th>Run</th><th>Steps</th><th>Cost</th>
      <th>Started</th><th>Branch</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function renderRun(
  run: Run,
  steps: Step[],
  annotations: Annotation[],
  forks: Array<{ fork_id: string; fork_run_id: string; edit_type: string; origin_step_id: string }>,
  stepDecisions: Map<string, string>,
): string {
  const meta = `<div class="meta-row">
    <div class="kv"><strong>Status</strong> <span class="pill ${esc(run.status)}">${esc(run.status)}</span></div>
    <div class="kv"><strong>Steps</strong> ${run.step_count}</div>
    <div class="kv"><strong>Cost</strong> ${(run.cost_cents / 100).toFixed(2)}$</div>
    <div class="kv"><strong>Input</strong> ${run.tokens_total_input.toLocaleString()}</div>
    <div class="kv"><strong>Output</strong> ${run.tokens_total_output.toLocaleString()}</div>
    <div class="kv"><strong>Cached</strong> ${run.tokens_total_cached.toLocaleString()}</div>
    <div class="kv"><strong>Branch</strong> ${esc(run.git_branch ?? "—")}</div>
    <div class="kv"><strong>Run ID</strong> <span class="mono">${esc(run.run_id)}</span></div>
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

  const runAnnotations = annotations.length
    ? `<div class="step-card"><h3>Run annotations</h3>${annotations
        .map(
          (a) =>
            `<div class="annotation"><strong>${esc(a.author)}</strong> · <em>${esc(a.verdict ?? "note")}</em> · ${esc(a.note ?? "")}</div>`,
        )
        .join("")}</div>`
    : "";

  const forksBlock = forks.length
    ? `<div class="step-card"><h3>Forks of this run</h3>${forks
        .map(
          (f) =>
            `<div class="annotation"><span class="pill fork">${esc(f.edit_type)}</span> from step <code>${esc(f.origin_step_id.slice(0, 12))}</code> → <a href="/runs/${esc(f.fork_run_id)}">${esc(f.fork_run_id.slice(0, 12))}</a> · <a href="/diff?a=${esc(run.run_id)}&b=${esc(f.fork_run_id)}">diff</a></div>`,
        )
        .join("")}</div>`
    : "";

  const stepCards = steps
    .map((s) => renderStepCard(s, stepDecisions.get(s.step_id) ?? ""))
    .join("");

  return `<h2 style="margin-top:0">${esc(run.title ?? run.run_id)}</h2>
    ${meta}
    ${timeline}
    ${runAnnotations}
    ${forksBlock}
    ${stepCards.length ? stepCards : `<div class="empty">No steps in this run.</div>`}`;
}

function renderStepCard(s: Step, decision: string): string {
  const status = `<span class="pill ${esc(s.status)}">${esc(s.status)}</span>`;
  const stepHeader = `<h3 data-seq="${s.sequence}">
    #${s.sequence} · ${esc(s.action.kind)}${s.action.tool_name ? ` · <code>${esc(s.action.tool_name)}</code>` : ""}
    ${status}
    <span class="pill">${esc(s.model)}</span>
  </h3>`;

  const tabBar = `<div class="tab-bar">
    <button class="tab-btn active" data-tab="decision" onclick="showTab('${esc(s.step_id)}','decision')">Decision</button>
    <button class="tab-btn" data-tab="action" onclick="showTab('${esc(s.step_id)}','action')">Action</button>
    <button class="tab-btn" data-tab="outcome" onclick="showTab('${esc(s.step_id)}','outcome')">Outcome</button>
    <button class="tab-btn" data-tab="cost" onclick="showTab('${esc(s.step_id)}','cost')">Cost</button>
    <button class="tab-btn" data-tab="context" onclick="showTab('${esc(s.step_id)}','context')">Context</button>
  </div>`;

  const decisionTab = `<div class="tab tab-decision"><pre class="body">${esc(prettyJson(decision))}</pre></div>`;
  const actionTab = `<div class="tab tab-action" style="display:none"><pre class="body">${esc(JSON.stringify(s.action, null, 2))}</pre></div>`;
  const outcomeTab = `<div class="tab tab-outcome" style="display:none"><pre class="body">${esc(JSON.stringify(s.outcome, null, 2))}</pre>${
    s.outcome.tool_result_ref
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
  const contextTab = `<div class="tab tab-context" style="display:none"><p><a href="/api/blob/${esc(s.context_snapshot_id)}" target="_blank">view context snapshot (${esc(s.context_snapshot_id.slice(0, 12))})</a></p></div>`;

  return `<div class="step-card" data-step="${esc(s.step_id)}">${stepHeader}${tabBar}${decisionTab}${actionTab}${outcomeTab}${costTab}${contextTab}</div>`;
}

function prettyJson(maybeJson: string): string {
  try {
    const obj = JSON.parse(maybeJson);
    return JSON.stringify(obj, null, 2);
  } catch {
    return maybeJson;
  }
}

export function renderDiff(a: Run, b: Run, d: DiffResult): string {
  const header = `<h2 style="margin-top:0">Diff: ${esc(a.title ?? a.run_id.slice(0, 12))} vs ${esc(b.title ?? b.run_id.slice(0, 12))}</h2>
    <div class="meta-row">
      <div class="kv"><strong>Shared prefix</strong> ${d.shared_prefix_length} steps</div>
      <div class="kv"><strong>First divergence</strong> ${d.first_divergence_sequence ?? "—"}</div>
      <div class="kv"><strong>Total steps</strong> A=${d.total_steps_a} B=${d.total_steps_b}</div>
    </div>`;
  const rows = d.rows
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

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
