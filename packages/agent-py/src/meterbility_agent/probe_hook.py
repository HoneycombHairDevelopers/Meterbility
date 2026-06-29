"""
SDK-side Probe hook — Python mirror of
``packages/agent/src/probe.ts``.

Runs before every model call when ``tracer.probe_enabled`` is True.
Implements the graceful-pause + inject contract from SPEC §7.1:

  1. If an operator has requested a pause, the SDK acknowledges via
     ``confirm_paused`` and blocks until the operator resumes. The
     CURRENT call (if any) is never interrupted — the check happens
     at the TOP of the wrapper, so any in-flight call completes
     naturally before we yield.

  2. After the pause check (or if no pause was active), the SDK
     consumes any pending inject and appends it to the request's
     ``messages`` list as a new user turn. This is how the operator's
     "hey, you forgot to check the fixture" nudge reaches the model.

When ``probe_enabled`` is False, none of this runs — cost is one
boolean check per call.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List

from .probe import confirm_paused, consume_inject, read_state


def _default_sleep(ms: int) -> None:
    time.sleep(ms / 1000)


def _default_now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class ProbeRuntime:
    """
    Tunables + testability seams for the probe hook. Production
    defaults to ``sleep = time.sleep``, ``now = time.time``.
    """

    poll_interval_ms: int = 250
    sleep: Callable[[int], None] = field(default=_default_sleep)
    now: Callable[[], int] = field(default=_default_now_ms)


DEFAULT_PROBE_RUNTIME = ProbeRuntime()


def apply_probe_to_request(
    run_id: str,
    req: Dict[str, Any],
    runtime: ProbeRuntime = DEFAULT_PROBE_RUNTIME,
) -> Dict[str, Any]:
    """
    Run the probe protocol against this call.

    1. Read current probe state.
    2. If ``pause_requested``, confirm and poll until ``running``.
    3. After unblocking, consume any pending inject and append it to
       ``req["messages"]`` as a user turn.

    Returns the (possibly modified) request. Caller passes the result
    on to the underlying SDK call. The input dict is never mutated.
    """
    state = read_state(run_id, runtime.now)

    # 1. Graceful pause — acknowledge and block until operator resumes.
    if state.state == "pause_requested":
        state = confirm_paused(run_id, runtime.now)
        while state.state != "running":
            runtime.sleep(runtime.poll_interval_ms)
            state = read_state(run_id, runtime.now)

    # 2. Inject — append any queued message as a new user turn.
    injected = consume_inject(run_id, runtime.now)
    if injected is None:
        return req

    # Shallow copy + new messages list. We don't deep-copy individual
    # message dicts — they're immutable from the SDK's perspective.
    out: Dict[str, Any] = dict(req)
    original: List[Dict[str, Any]] = list(req.get("messages") or [])
    out["messages"] = original + [{"role": "user", "content": injected}]
    return out
