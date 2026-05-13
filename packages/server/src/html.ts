import type { Annotation, Run, Step } from "@spool/shared";
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
    border-radius: 6px; margin-bottom: 12px;
    position: sticky; top: 52px; z-index: 5;
    max-height: 140px; overflow-y: auto;
  }
  .filter-bar {
    display: flex; align-items: center; gap: 8px;
    margin: 0 0 10px 0; flex-wrap: wrap;
  }
  .filter-chip {
    padding: 3px 10px; border-radius: 12px; font-size: 12px;
    background: var(--bg-2); border: 1px solid var(--border);
    color: var(--fg-mute); cursor: pointer; user-select: none;
  }
  .filter-chip:hover { color: var(--fg); }
  .filter-chip.active {
    background: var(--bg-3); color: var(--fg);
    border-color: var(--accent);
  }
  .filter-input {
    background: var(--bg); border: 1px solid var(--border);
    color: var(--fg); border-radius: 4px;
    padding: 3px 8px; font-size: 12.5px;
    min-width: 180px;
  }
  .filter-input::placeholder { color: var(--fg-mute); }
  .filter-input:focus {
    outline: none; border-color: var(--accent);
  }
  .copy-btn {
    background: transparent; border: 1px solid transparent;
    color: var(--fg-mute); border-radius: 3px;
    padding: 0 4px; font-size: 11px; cursor: pointer;
    font-family: inherit;
  }
  .copy-btn:hover { color: var(--fg); border-color: var(--border); background: var(--bg-3); }
  .copy-btn.copied { color: var(--ok); }

  /* Keyboard help overlay */
  .kbd-help {
    position: fixed; right: 18px; bottom: 18px; z-index: 50;
    background: var(--bg-2); border: 1px solid var(--border);
    border-radius: 6px; padding: 10px 14px;
    font-size: 12px; display: none;
    box-shadow: 0 6px 24px rgba(0,0,0,0.4);
  }
  .kbd-help.open { display: block; }
  .kbd-help kbd {
    background: var(--bg-3); border: 1px solid var(--border);
    border-bottom-width: 2px;
    padding: 0 5px; border-radius: 3px;
    font-family: ui-monospace, Menlo, monospace; font-size: 11px;
    color: var(--fg);
  }
  .kbd-help-toggle {
    position: fixed; right: 18px; bottom: 18px; z-index: 49;
    width: 28px; height: 28px; border-radius: 14px;
    background: var(--bg-2); border: 1px solid var(--border);
    color: var(--fg-mute); cursor: pointer;
    font-size: 14px; line-height: 1;
  }
  .kbd-help-toggle:hover { color: var(--fg); border-color: var(--accent); }
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
    /* Sticky <header> is ~52px tall; leave room when scrolling to a card. */
    scroll-margin-top: 64px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .step-card.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent) inset, 0 4px 16px rgba(88,166,255,0.08);
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

  .live-badge {
    font-size: 11px; padding: 2px 8px; border-radius: 10px;
    background: rgba(63,185,80,0.12); color: var(--ok);
    border: 1px solid rgba(63,185,80,0.35);
    font-family: ui-monospace, Menlo, monospace;
  }
  .live-badge.static {
    background: var(--bg-3); color: var(--fg-mute);
    border-color: var(--border);
  }
  .static-banner {
    background: var(--bg-2); border: 1px dashed var(--border);
    border-radius: 6px; padding: 8px 12px;
    font-size: 12px; color: var(--fg-mute);
    margin-bottom: 12px;
  }
  .static-banner code {
    background: var(--bg-3); padding: 1px 6px; border-radius: 3px;
    color: var(--fg);
  }

  /* Modals */
  .modal-bg {
    position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    display: none; align-items: center; justify-content: center; z-index: 100;
  }
  .modal-bg.open { display: flex; }
  .modal {
    background: var(--bg-2); border: 1px solid var(--border);
    border-radius: 8px; padding: 18px 20px; width: 540px; max-width: 92vw;
    max-height: 80vh; overflow: auto;
    box-shadow: 0 12px 48px rgba(0,0,0,0.5);
  }
  .modal h3 { margin: 0 0 12px 0; font-size: 14px; }
  .modal label { display: block; font-size: 12px; color: var(--fg-mute); margin-bottom: 4px; margin-top: 10px; }
  .modal input, .modal textarea, .modal select {
    width: 100%; padding: 6px 8px; background: var(--bg);
    border: 1px solid var(--border); color: var(--fg);
    border-radius: 4px; font-size: 13px; font-family: inherit;
  }
  .modal textarea { min-height: 80px; resize: vertical; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; }
  .modal .actions { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }
  .modal button {
    padding: 6px 14px; background: var(--bg-3); color: var(--fg);
    border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
    font-size: 13px;
  }
  .modal button.primary { background: var(--accent); color: #0e1116; border-color: var(--accent); }
  .modal button:hover { background: var(--border); }
  .modal button.primary:hover { background: #4a8fde; }

  /* Step card additions */
  .step-card .row-actions {
    display: flex; gap: 6px; align-items: center;
  }
  .step-card .row-actions button {
    background: var(--bg-3); border: 1px solid var(--border); color: var(--fg-mute);
    border-radius: 3px; padding: 2px 8px; font-size: 11px; cursor: pointer;
  }
  .step-card .row-actions button:hover { color: var(--fg); }
  .annotations-list {
    margin-top: 8px; display: flex; flex-direction: column; gap: 4px;
  }

  /* Tests page */
  .tests-grid {
    display: grid; grid-template-columns: 280px 1fr; gap: 16px; min-height: 400px;
  }
  .test-list {
    background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px; overflow: auto; max-height: 75vh;
  }
  .test-list .item {
    display: block; padding: 6px 8px; border-radius: 4px;
    color: var(--fg); cursor: pointer; font-size: 12.5px;
  }
  .test-list .item:hover { background: var(--bg-3); }
  .test-list .item.active { background: var(--bg-3); color: var(--accent); }
  .test-list .item .meta { font-size: 11px; color: var(--fg-mute); }
  .test-detail {
    background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px;
    padding: 14px 16px; min-height: 200px;
  }
  .assertion-row {
    display: grid; grid-template-columns: 160px 1fr 80px 30px;
    gap: 8px; align-items: center; padding: 4px 0;
    border-bottom: 1px dashed var(--border);
  }
  .assertion-row select, .assertion-row input {
    background: var(--bg); border: 1px solid var(--border);
    color: var(--fg); border-radius: 3px; padding: 4px 6px; font-size: 12.5px;
  }
  .assertion-row .rm { background: transparent; color: var(--err); border: none; cursor: pointer; }
  .results-list {
    margin-top: 14px;
    border-top: 1px solid var(--border); padding-top: 10px;
  }
  .results-list .row {
    font-family: ui-monospace, Menlo, monospace; font-size: 12px;
    padding: 3px 0;
  }
  .results-list .pass { color: var(--ok); }
  .results-list .fail { color: var(--err); }
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
});

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
  const body = {
    origin_run_id: document.getElementById('fork-run-id').value,
    at: parseInt(document.getElementById('fork-seq').value, 10),
    edit_type: document.getElementById('fork-edit-type').value,
    edit_payload: { text: document.getElementById('fork-payload').value },
    fake: document.getElementById('fork-fake').value || undefined,
    live: document.getElementById('fork-live').checked,
  };
  try {
    const res = await fetch('/api/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'fork failed');
    status.innerHTML = 'fork created → <a href="/runs/' + data.fork_run_id + '">open</a> · <a href="/diff?a=' + body.origin_run_id + '&b=' + data.fork_run_id + '">diff</a>';
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
    '<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">' + escapeHtml(t.name) + '</h3>' +
    '<div><button onclick="addAssertionRow()">+ assertion</button> <button class="primary" onclick="saveAssertions()">Save</button> <button onclick="runTestAgainstAll()">Run on all runs</button></div></div>' +
    (t.description ? '<p style="color:var(--fg-mute);font-size:12.5px">' + escapeHtml(t.description) + '</p>' : '') +
    '<div id="assertions-area">' + rows + '</div>' +
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
  const liveBadge = opts.liveMode
    ? `<span class="live-badge" title="--live mode: SSE updates enabled">● live</span>`
    : `<span class="live-badge static" title="--live not enabled. Restart with: spool web --live">○ static</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)} · Spool</title>
<meta name="spool-live-mode" content="${opts.liveMode ? "1" : "0"}">
<style>${STYLES}</style>
</head><body>
<header>
  <h1><a href="/">Spool</a></h1>
  <nav style="display:flex;gap:14px;font-size:13px;color:var(--fg-mute)">
    <a href="/">Fleet</a>
    <a href="/runs">Runs</a>
    <a href="/tests">Tests</a>
  </nav>
  ${liveBadge}
  <span class="crumbs">${esc(title)}</span>
  <span id="flash" style="margin-left:auto;font-size:12px"></span>
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
  return `<div id="alert-banner" style="margin-bottom:12px"></div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:12px">
      <div>
        <h2 style="margin:0">Fleet</h2>
        <div style="font-size:12px;color:var(--fg-mute);margin-top:2px">${esc(subtitle)}</div>
      </div>
      <div class="meta-row" style="margin:0">
        <span class="kv"><strong>${entries.length}</strong> run(s)</span>
        <span class="kv"><a href="/runs">all runs →</a></span>
      </div>
    </div>
    ${banner}
    <div id="fleet-grid" class="fleet">${initial || empty}</div>`;
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
    <div class="kv"><strong>Run ID</strong> <span class="mono">${esc(run.run_id.slice(0, 16))}…</span>
      <button class="copy-btn" title="copy full run id" onclick="copyText('${esc(run.run_id)}', this)">copy</button>
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
    <h3 style="display:flex;align-items:center;gap:8px">
      <span>Run annotations</span>
      <span class="row-actions" style="margin-left:auto">
        <button onclick="openAnnotateModal('run', '${esc(run.run_id)}')">+ annotate</button>
      </span>
    </h3>
    ${
      annotations.length
        ? annotations
            .map(
              (a) =>
                `<div class="annotation"><strong>${esc(a.author)}</strong> · <em>${esc(a.verdict ?? "note")}</em> · ${esc(a.note ?? "")}</div>`,
            )
            .join("")
        : '<p style="color:var(--fg-mute);font-size:12.5px;margin:0">No annotations yet.</p>'
    }
  </div>`;

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
    ${filterBar}
    ${runAnnotations}
    ${forksBlock}
    ${stepCards.length ? stepCards : `<div class="empty">No steps in this run.</div>`}`;
}

function renderStepCard(s: Step, decision: string): string {
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

  return `<div class="step-card" id="step-${s.sequence}" data-step="${esc(s.step_id)}" data-step-seq="${s.sequence}" data-action-kind="${esc(s.action.kind)}" data-step-status="${esc(s.status)}">${stepHeader}${tabBar}${decisionTab}${actionTab}${outcomeTab}${costTab}${contextTab}</div>`;
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

  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
    <h2 style="margin:0">Regression tests</h2>
    <button class="primary" onclick="createNewTest()" style="background:var(--accent);color:#0e1116;border:1px solid var(--accent);padding:6px 14px;border-radius:4px;cursor:pointer">+ New test</button>
  </div>
  <div class="tests-grid">
    <div class="test-list">${items}</div>
    <div id="test-detail" class="test-detail">
      <div class="empty">Select a test from the left to edit, or create a new one.</div>
    </div>
  </div>
  <div style="margin-top:18px">
    <h3 style="margin-bottom:8px;font-size:13px;color:var(--fg-mute);text-transform:uppercase;letter-spacing:0.05em">Recent results (all tests)</h3>
    <div class="results-list">${recentRows}</div>
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
