"""
Live Probe protocol — Python mirror of ``packages/shared/src/probe.ts``.

Track B / Turn 8 chunk 3. The file format is byte-compatible with the
TS implementation: both write/read ``$METERBILITY_HOME/probe/<run_id>.json``
with the same field shape, so a TS-side ``requestPause`` is observed
by a Python SDK and vice versa. That cross-language symmetry is the
whole point of putting the protocol in a file (no shared in-process
state required).

State machine (identical to TS):

    running
      │
      │ request_pause()             [operator]
      ▼
    pause_requested
      │
      │ confirm_paused()            [SDK, after finishing current call]
      ▼
    paused
      │
      │ request_resume()            [operator]
      ▼
    running

``set_inject(msg)`` is allowed in any state. ``consume_inject`` reads
and atomically clears.

Atomic writes use ``os.replace`` (the Python wrapper for POSIX rename),
which is atomic on a single filesystem. Concurrent readers always see
either the old or new file, never a half-written one.
"""

from __future__ import annotations

import errno
import json
import os
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal, Optional

from .paths import meter_home


#: Runtime probe FSM state. Lives in the on-disk JSON record at
#: ``~/.meterbility/probe/<run_id>.json`` and drives the live
#: pause/inject/resume protocol between operator and SDK.
#:
#: Distinct from the persisted ``Run.probe_state`` column in the TS
#: collector (``"paused" | "resumed" | None``), which is the
#: historical marker the trace format carries forward. Same name on
#: that side was a collision; the Python SDK never owned the column
#: type, so renaming here is purely a clarity pass for parity with
#: ``ProbeFsmState`` in the TS shared package.
ProbeFsmState = Literal["running", "pause_requested", "paused"]
_VALID_STATES = ("running", "pause_requested", "paused")


@dataclass
class ProbeRecord:
    """Mirror of the TS ``ProbeRecord`` interface."""

    run_id: str
    state: ProbeFsmState
    inject: Optional[str]
    requested_at_ms: Optional[int]
    paused_at_ms: Optional[int]
    resumed_at_ms: Optional[int]
    updated_at_ms: int


def probe_dir() -> Path:
    return meter_home() / "probe"


def probe_file_path(run_id: str) -> Path:
    """
    URL-encode the run_id so path-traversal characters in a hostile or
    malformed id can't escape the probe directory. Mirrors the TS
    ``encodeURIComponent`` behavior.
    """
    encoded = urllib.parse.quote(run_id, safe="")
    return probe_dir() / f"{encoded}.json"


def _now_ms_default() -> int:
    return int(time.time() * 1000)


def _default_record(run_id: str, now_ms: int) -> ProbeRecord:
    return ProbeRecord(
        run_id=run_id,
        state="running",
        inject=None,
        requested_at_ms=None,
        paused_at_ms=None,
        resumed_at_ms=None,
        updated_at_ms=now_ms,
    )


def read_state(
    run_id: str, now: Callable[[], int] = _now_ms_default
) -> ProbeRecord:
    """
    Read the current probe record. Returns the default "running, no
    inject" record when no probe file exists — callers never need to
    distinguish "file absent" from "state is running."

    Corrupt files (bad JSON, hand-edited garbage) collapse to the same
    default rather than raising; that keeps the SDK poll loop alive
    even when a user breaks the file by hand.
    """
    path = probe_file_path(run_id)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return _default_record(run_id, now())
    except OSError as exc:
        # EACCES, EIO, ENOTDIR, etc. are real problems — surface them.
        if exc.errno == errno.ENOENT:
            return _default_record(run_id, now())
        raise

    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return _default_record(run_id, now())
    return _normalize(parsed, run_id, now())


def _normalize(parsed: object, run_id: str, now_ms: int) -> ProbeRecord:
    """
    Coerce a parsed-JSON object back into a valid ProbeRecord. Unknown
    fields drop; missing fields take safe defaults; bad state strings
    collapse to ``running``.
    """
    if not isinstance(parsed, dict):
        return _default_record(run_id, now_ms)
    state_raw = parsed.get("state")
    state: ProbeFsmState = (
        state_raw if state_raw in _VALID_STATES else "running"  # type: ignore[assignment]
    )
    inject_raw = parsed.get("inject")
    inject = inject_raw if isinstance(inject_raw, str) else None
    return ProbeRecord(
        run_id=parsed.get("run_id") if isinstance(parsed.get("run_id"), str) else run_id,
        state=state,
        inject=inject,
        requested_at_ms=_as_int_or_none(parsed.get("requested_at_ms")),
        paused_at_ms=_as_int_or_none(parsed.get("paused_at_ms")),
        resumed_at_ms=_as_int_or_none(parsed.get("resumed_at_ms")),
        updated_at_ms=_as_int_or_none(parsed.get("updated_at_ms")) or now_ms,
    )


def _as_int_or_none(v: object) -> Optional[int]:
    return v if isinstance(v, int) else None


def _to_dict(rec: ProbeRecord) -> dict:
    return {
        "run_id": rec.run_id,
        "state": rec.state,
        "inject": rec.inject,
        "requested_at_ms": rec.requested_at_ms,
        "paused_at_ms": rec.paused_at_ms,
        "resumed_at_ms": rec.resumed_at_ms,
        "updated_at_ms": rec.updated_at_ms,
    }


def _mutate(
    run_id: str,
    transform: Callable[[ProbeRecord, int], ProbeRecord],
    now: Callable[[], int] = _now_ms_default,
) -> ProbeRecord:
    """
    Read-modify-write helper. Samples the clock ONCE per mutation so
    every timestamp in the resulting record agrees with itself.
    """
    now_ms = now()
    current = read_state(run_id, lambda: now_ms)
    next_rec = transform(current, now_ms)
    # Always restamp updated_at to the mutation's clock sample, even
    # for "no-op" transforms — the file-on-disk timestamp is what
    # external watchers (web SSE, CLI) use to detect changes.
    next_rec = ProbeRecord(
        run_id=next_rec.run_id,
        state=next_rec.state,
        inject=next_rec.inject,
        requested_at_ms=next_rec.requested_at_ms,
        paused_at_ms=next_rec.paused_at_ms,
        resumed_at_ms=next_rec.resumed_at_ms,
        updated_at_ms=now_ms,
    )
    path = probe_file_path(run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(_to_dict(next_rec), indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return next_rec


def request_pause(
    run_id: str, now: Callable[[], int] = _now_ms_default
) -> ProbeRecord:
    """
    Operator side: request a graceful pause. Idempotent — if the run
    is already ``pause_requested`` or ``paused``, the original
    timestamps are preserved.
    """
    def transform(cur: ProbeRecord, now_ms: int) -> ProbeRecord:
        if cur.state in ("pause_requested", "paused"):
            return cur
        return ProbeRecord(
            run_id=cur.run_id,
            state="pause_requested",
            inject=cur.inject,
            requested_at_ms=now_ms,
            paused_at_ms=cur.paused_at_ms,
            resumed_at_ms=cur.resumed_at_ms,
            updated_at_ms=now_ms,
        )

    return _mutate(run_id, transform, now)


def confirm_paused(
    run_id: str, now: Callable[[], int] = _now_ms_default
) -> ProbeRecord:
    """
    SDK side: acknowledge the pause request after finishing the
    current model call. No-op when the operator already resumed
    (race window between ``pause_requested`` and SDK polling).
    """
    def transform(cur: ProbeRecord, now_ms: int) -> ProbeRecord:
        if cur.state != "pause_requested":
            return cur
        return ProbeRecord(
            run_id=cur.run_id,
            state="paused",
            inject=cur.inject,
            requested_at_ms=cur.requested_at_ms,
            paused_at_ms=now_ms,
            resumed_at_ms=cur.resumed_at_ms,
            updated_at_ms=now_ms,
        )

    return _mutate(run_id, transform, now)


def set_inject(
    run_id: str, message: str, now: Callable[[], int] = _now_ms_default
) -> ProbeRecord:
    """
    Operator side: queue a message to be appended to the next user
    turn. Allowed in any state. Overwrites a previous pending inject
    (operator UI is responsible for warning before stomping one).
    """
    def transform(cur: ProbeRecord, now_ms: int) -> ProbeRecord:
        return ProbeRecord(
            run_id=cur.run_id,
            state=cur.state,
            inject=message,
            requested_at_ms=cur.requested_at_ms,
            paused_at_ms=cur.paused_at_ms,
            resumed_at_ms=cur.resumed_at_ms,
            updated_at_ms=now_ms,
        )

    return _mutate(run_id, transform, now)


def consume_inject(
    run_id: str, now: Callable[[], int] = _now_ms_default
) -> Optional[str]:
    """SDK side: read and atomically clear the pending inject."""
    taken: list = [None]

    def transform(cur: ProbeRecord, now_ms: int) -> ProbeRecord:
        taken[0] = cur.inject
        if cur.inject is None:
            return cur
        return ProbeRecord(
            run_id=cur.run_id,
            state=cur.state,
            inject=None,
            requested_at_ms=cur.requested_at_ms,
            paused_at_ms=cur.paused_at_ms,
            resumed_at_ms=cur.resumed_at_ms,
            updated_at_ms=now_ms,
        )

    _mutate(run_id, transform, now)
    return taken[0]


def request_resume(
    run_id: str, now: Callable[[], int] = _now_ms_default
) -> ProbeRecord:
    """
    Operator side: resume the run. Transitions any state back to
    ``running``. Inject is NOT cleared (resume-with-pending-inject is
    a valid pattern — operator wants the message delivered next).
    """
    def transform(cur: ProbeRecord, now_ms: int) -> ProbeRecord:
        if cur.state == "running":
            return cur
        return ProbeRecord(
            run_id=cur.run_id,
            state="running",
            inject=cur.inject,
            requested_at_ms=cur.requested_at_ms,
            paused_at_ms=cur.paused_at_ms,
            resumed_at_ms=now_ms,
            updated_at_ms=now_ms,
        )

    return _mutate(run_id, transform, now)


def clear_probe(run_id: str) -> None:
    """
    Terminal cleanup. Safe to call when no file exists — used by
    ``tracer.end()`` so a stale ``paused`` state can't linger.
    """
    path = probe_file_path(run_id)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        if exc.errno != errno.ENOENT:
            raise
