"""
``MeterbilityTracer`` and ``MeterbilityStep`` — the Python SDK's public surface.

Mirrors packages/agent/src/tracer.ts + step.ts in spirit:

  - One tracer instance = one Run.
  - tracer.start_step() returns a MeterbilityStep the caller fills imperatively.
  - step.end() persists the step + bumps run totals. Idempotent on re-call.
  - tracer.end() seals the Run row and closes the underlying SQLite handle.

The capture surface is imperative on purpose: most agent code already
has an event-loop shape ("call model, get reply, run tool, get
result"), and forcing it into a different idiom costs more than it
earns.
"""

from __future__ import annotations

import os
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Union

from .blobs import BlobStore
from .hashing import hash_json
from .pricing import cost_cents
from .probe import clear_probe
from .probe_hook import DEFAULT_PROBE_RUNTIME, ProbeRuntime
from .queries import (
    insert_run,
    insert_step,
    now_iso,
    record_context_snapshot,
    set_run_status,
    update_run_totals,
    upsert_agent,
    upsert_project_by_cwd,
)
from .store import Store


Message = Dict[str, Any]  # {"role": "user"|"assistant"|"tool", "content": str}
RetrievedDoc = Dict[str, str]  # {"source": str, "content": str}


class MeterbilityTracer:
    """
    One tracer = one Run. Open, call ``start_step()`` per model call,
    then call ``end()`` to seal the run.

    Example::

        tracer = MeterbilityTracer(project="my-app", agent="support")
        step = tracer.start_step(model="claude-opus-4-7", history=[...])
        # ...call model...
        step.record_message("hi").record_tokens(input=10, output=2)
        step.end()
        tracer.end()
    """

    def __init__(
        self,
        *,
        project: str,
        agent: str,
        run_title: Optional[str] = None,
        tags: Optional[Iterable[str]] = None,
        meter_home_override: Optional[str] = None,
        source_runtime: str = "sdk-py",
        source_session_id: Optional[str] = None,
        cwd: Optional[str] = None,
        git_branch: Optional[str] = None,
        probe_enabled: bool = False,
        probe_poll_interval_ms: int = 250,
    ) -> None:
        if meter_home_override:
            os.environ["METERBILITY_HOME"] = meter_home_override
        self.store = Store.open()
        cwd_eff = cwd or project
        project_row = upsert_project_by_cwd(self.store.db, cwd_eff, project)
        self.project_id: str = project_row["project_id"]
        agent_row = upsert_agent(self.store.db, self.project_id, agent)
        self.agent_id: str = agent_row["agent_id"]
        self.run_id: str = f"run_{uuid.uuid4()}"
        self._started_at = now_iso()
        self._step_count = 0
        self._prev_step_id: Optional[str] = None
        self._ended = False
        self._status: str = "in_progress"

        insert_run(
            self.store.db,
            {
                "run_id": self.run_id,
                "agent_id": self.agent_id,
                "project_id": self.project_id,
                "source_session_id": source_session_id,
                "source_runtime": source_runtime,
                "title": run_title,
                "status": "in_progress",
                "started_at": self._started_at,
                "git_branch": git_branch,
                "cwd": cwd_eff,
                "tags": list(tags or []),
            },
        )

        # Live Probe config. ``probe_enabled`` defaults to False so
        # there's zero overhead when the operator isn't using the
        # probe; toggling it on lets ``meter probe`` and the web probe
        # panel pause/inject/resume against this run.
        self.probe_enabled: bool = probe_enabled
        self.probe_runtime: ProbeRuntime = ProbeRuntime(
            poll_interval_ms=probe_poll_interval_ms,
            sleep=DEFAULT_PROBE_RUNTIME.sleep,
            now=DEFAULT_PROBE_RUNTIME.now,
        )

    def start_step(
        self,
        *,
        model: str,
        system_prompt: Optional[str] = None,
        tool_definitions: Optional[Any] = None,
        history: Optional[List[Message]] = None,
        retrieved_docs: Optional[List[RetrievedDoc]] = None,
        extra_components: Optional[List[Dict[str, Any]]] = None,
        tags: Optional[Iterable[str]] = None,
    ) -> "MeterbilityStep":
        seq = self._step_count
        step = MeterbilityStep(
            tracer=self,
            sequence=seq,
            parent_step_id=self._prev_step_id,
            started_at_ms=time.monotonic() * 1000,
            options={
                "model": model,
                "system_prompt": system_prompt,
                "tool_definitions": tool_definitions,
                "history": history or [],
                "retrieved_docs": retrieved_docs or [],
                "extra_components": extra_components or [],
                "tags": list(tags or []),
            },
        )
        self._step_count += 1
        self._prev_step_id = step.step_id
        return step

    def end(self, *, status: Optional[str] = None) -> None:
        """Seal the run row. Idempotent — safe to call from a finally block."""
        if self._ended:
            return
        self._ended = True
        final_status = status or self._status
        set_run_status(self.store.db, self.run_id, final_status, now_iso())
        update_run_totals(self.store.db, self.run_id)
        # Terminal cleanup for the probe surface. Safe (and a no-op)
        # when probe was never enabled or no operator interacted with
        # this run.
        clear_probe(self.run_id)
        self.store.close()

    # ---- context-manager sugar ----
    def __enter__(self) -> "MeterbilityTracer":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        # If the body raised, mark the run as error before sealing — keeps
        # the run row honest without forcing every user to remember to.
        if exc is not None and self._status != "error":
            self._status = "error"
        self.end()

    # ---- internal hooks ----
    def _step_completed(self, step_status: str) -> None:
        if step_status == "error":
            self._status = "error"
        elif step_status == "ok" and self._status != "error":
            self._status = "ok"

    def _refresh_totals(self) -> None:
        update_run_totals(self.store.db, self.run_id)


class MeterbilityStep:
    """
    One Step builder. Fill in decision/action/outcome/tokens by chained
    ``record_*`` calls, then ``end()`` to persist. ``end()`` is idempotent
    on re-call (errors loudly — matches JS).

    All record_* methods return ``self`` so they're chainable::

        step.record_message("hi").record_tokens(input=10, output=2).end()
    """

    def __init__(
        self,
        *,
        tracer: MeterbilityTracer,
        sequence: int,
        parent_step_id: Optional[str],
        started_at_ms: float,
        options: Dict[str, Any],
    ) -> None:
        self.step_id: str = f"stp_{uuid.uuid4()}"
        self.sequence = sequence
        self.parent_step_id = parent_step_id
        self._tracer = tracer
        self._model: str = options["model"]
        self._started_at_ms = started_at_ms
        self._started_at_iso = now_iso()
        self._options = options
        self._decision_content: Any = None
        self._action: Dict[str, Any] = {"kind": "none"}
        self._outcome: Dict[str, Any] = {"status": "pending"}
        self._tokens: Dict[str, int] = {
            "input": 0,
            "output": 0,
            "cached_read": 0,
            "cache_creation": 0,
        }
        self._explicit_latency_ms: Optional[int] = None
        self._tags: List[str] = list(options.get("tags") or [])
        self._pending_tool_result: Any = _UNSET
        self._ended = False

    # ---- record_* ---------------------------------------------------------

    def record_decision(self, *, decision: Any, action: Dict[str, Any]) -> "MeterbilityStep":
        self._decision_content = decision
        self._action = action
        return self

    def record_action(self, action: Dict[str, Any]) -> "MeterbilityStep":
        self._action = action
        return self

    def record_tool_call(
        self, name: str, tool_input: Any, tool_use_id: Optional[str] = None
    ) -> "MeterbilityStep":
        self._action = {
            "kind": "tool_call",
            "tool_name": name,
            "tool_use_id": tool_use_id,
            "tool_input": tool_input,
        }
        return self

    def record_message(self, text: str) -> "MeterbilityStep":
        self._action = {"kind": "message", "text": text}
        return self

    def record_outcome(self, outcome: Dict[str, Any]) -> "MeterbilityStep":
        self._outcome = outcome
        return self

    def record_tool_result(
        self,
        content: Any,
        *,
        is_error: bool = False,
        summary: Optional[str] = None,
    ) -> "MeterbilityStep":
        self._outcome = {
            "status": "error" if is_error else "ok",
            "is_error": is_error,
        }
        if summary is not None:
            self._outcome["summary"] = summary
        self._pending_tool_result = content
        return self

    def record_tokens(
        self,
        *,
        input: int = 0,  # noqa: A002 — matches JS field name
        output: int = 0,
        cached_read: int = 0,
        cache_creation: int = 0,
        cache_creation_1h: int = 0,
        reasoning: Optional[int] = None,
        latency_ms: Optional[int] = None,
    ) -> "MeterbilityStep":
        self._tokens = {
            "input": input,
            "output": output,
            "cached_read": cached_read,
            "cache_creation": cache_creation,
            "cache_creation_1h": cache_creation_1h,
        }
        if reasoning is not None:
            self._tokens["reasoning"] = reasoning
        if latency_ms is not None:
            self._explicit_latency_ms = latency_ms
        return self

    def tag(self, tag: str) -> "MeterbilityStep":
        if tag not in self._tags:
            self._tags.append(tag)
        return self

    # ---- end --------------------------------------------------------------

    def end(self) -> Dict[str, Any]:
        """Persist the step. Returns the row that was written."""
        if self._ended:
            raise RuntimeError("MeterbilityStep.end() called twice")
        self._ended = True

        # Build & persist context components.
        components = _build_context_components(self._tracer.store.blobs, self._options)
        snapshot_id = hash_json(components)
        snap_blob_ref = self._tracer.store.blobs.put_json(
            {"id": snapshot_id, "components": components}
        )
        record_context_snapshot(
            self._tracer.store.db,
            snapshot_id,
            snap_blob_ref,
            len(components),
        )

        # Decision blob (caller's raw model output).
        decision_ref = self._tracer.store.blobs.put_json(self._decision_content)

        # Tool result blob (if recorded).
        if self._pending_tool_result is not _UNSET:
            tr_ref = self._tracer.store.blobs.put_json(self._pending_tool_result)
            self._outcome = {**self._outcome, "tool_result_ref": tr_ref}

        # Latency: explicit > wall-clock since start.
        if self._explicit_latency_ms is not None:
            latency_ms = self._explicit_latency_ms
        else:
            latency_ms = int(time.monotonic() * 1000 - self._started_at_ms)

        cost, approx = cost_cents(self._model, self._tokens)
        if approx and "cost:approx" not in self._tags:
            self._tags.append("cost:approx")

        status = (
            "error"
            if self._outcome.get("status") == "error"
            else "in_progress"
            if self._outcome.get("status") == "pending"
            else "ok"
        )

        step_row = {
            "step_id": self.step_id,
            "run_id": self._tracer.run_id,
            "parent_step_id": self.parent_step_id,
            "sequence": self.sequence,
            "timestamp": self._started_at_iso,
            "model": self._model,
            "context_snapshot_id": snapshot_id,
            "decision_ref": decision_ref,
            "action": self._action,
            "outcome": self._outcome,
            "tokens": self._tokens,
            "latency_ms": latency_ms,
            "cost_cents": cost,
            "tags": self._tags,
            "status": status,
        }
        insert_step(self._tracer.store.db, step_row)
        self._tracer._step_completed(status)
        self._tracer._refresh_totals()
        return step_row


# ---- helpers -------------------------------------------------------------

_UNSET = object()


def _build_context_components(
    blobs: BlobStore, opts: Dict[str, Any]
) -> List[Dict[str, Any]]:
    components: List[Dict[str, Any]] = []

    sys_prompt = opts.get("system_prompt")
    if sys_prompt is not None:
        components.append(
            {
                "type": "system_prompt",
                "content_ref": blobs.put_string(sys_prompt),
            }
        )

    tool_defs = opts.get("tool_definitions")
    if tool_defs is not None:
        components.append(
            {
                "type": "tool_definitions",
                "content_ref": blobs.put_json(tool_defs),
            }
        )

    history = opts.get("history") or []
    if history:
        messages = []
        for m in history:
            messages.append(
                {
                    "role": m["role"],
                    "content_ref": blobs.put_string(m["content"]),
                }
            )
        components.append(
            {"type": "conversation_history", "messages": messages}
        )

    docs = opts.get("retrieved_docs") or []
    if docs:
        rendered = []
        for d in docs:
            rendered.append(
                {
                    "source": d["source"],
                    "content_ref": blobs.put_string(d["content"]),
                }
            )
        components.append({"type": "retrieved_documents", "docs": rendered})

    extras = opts.get("extra_components") or []
    components.extend(extras)
    return components
