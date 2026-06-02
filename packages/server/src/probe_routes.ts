/**
 * Canonical probe URL builders. Single source of truth for probe paths.
 *
 * Per SPEC-V0_3 §4 + §8.4, probe routes live under the run namespace:
 * `/api/runs/:id/probe/{state,panel,pause,resume,inject,clear}`.
 *
 * The legacy `/api/probe/:run_id/*` paths predate the spec; they still
 * work via HTTP 308 redirects (web.ts) with a `Deprecation: true`
 * header (RFC 8594). The redirect alias is scheduled for removal in
 * v0.4 — UI code, CLI scripts, and any external monitors should use
 * `probeRoutes()` rather than hardcoding strings.
 */
export function probeRoutes(runId: string): {
  state: string;
  panel: string;
  pause: string;
  resume: string;
  inject: string;
  clear: string;
} {
  const base = `/api/runs/${encodeURIComponent(runId)}/probe`;
  return {
    state: base,
    panel: `${base}/panel`,
    pause: `${base}/pause`,
    resume: `${base}/resume`,
    inject: `${base}/inject`,
    clear: `${base}/clear`,
  };
}

/**
 * Legacy probe paths (deprecated, kept for back-compat). Mirror of
 * `probeRoutes` shape so tests can iterate both at once. Not exported
 * to UI code — only the redirect handlers in web.ts reference these.
 */
export function legacyProbeRoutes(runId: string): {
  state: string;
  panel: string;
  pause: string;
  resume: string;
  inject: string;
  clear: string;
} {
  const base = `/api/probe/${encodeURIComponent(runId)}`;
  return {
    state: base,
    panel: `${base}/panel`,
    pause: `${base}/pause`,
    resume: `${base}/resume`,
    inject: `${base}/inject`,
    clear: `${base}/clear`,
  };
}
