"""
Anthropic SDK shortcut — analogous to ``traceAnthropic`` in the TS SDK.

Wraps an ``anthropic.Anthropic`` client so every ``client.messages.create()``
call captures one Step automatically. The wrapped client behaves
otherwise identically — returns the same ``Message`` object the underlying
SDK produced.

Usage::

    from anthropic import Anthropic
    from spool_agent import SpoolTracer, trace_anthropic

    tracer = SpoolTracer(project="my-app", agent="support")
    traced = trace_anthropic(tracer, Anthropic())

    resp = traced.messages.create(
        model="claude-opus-4-7",
        max_tokens=1024,
        system="you are helpful",
        messages=[{"role": "user", "content": "hello"}],
    )

Only sync ``Anthropic`` is wrapped. Async users can call
``tracer.start_step()`` manually around their ``AsyncAnthropic`` calls.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from .probe_hook import apply_probe_to_request
from .tracer import SpoolTracer


def trace_anthropic(tracer: SpoolTracer, client: Any) -> Any:
    """
    Return a thin proxy that intercepts ``client.messages.create(...)``
    and emits one Spool Step per call. Other attributes pass through.
    """
    return _TracedAnthropic(tracer, client)


class _TracedAnthropic:
    def __init__(self, tracer: SpoolTracer, client: Any) -> None:
        self._tracer = tracer
        self._client = client
        self.messages = _TracedMessages(tracer, client.messages)

    def __getattr__(self, name: str) -> Any:
        # Pass-through for everything else (e.g. .beta, .completions).
        return getattr(self._client, name)


class _TracedMessages:
    def __init__(self, tracer: SpoolTracer, messages: Any) -> None:
        self._tracer = tracer
        self._messages = messages

    def create(self, **req: Any) -> Any:  # noqa: ANN401
        # Live Probe hook (gated on tracer.probe_enabled). If the
        # operator has requested a pause, this blocks until they
        # resume. If they've queued an inject message, it's appended
        # to req["messages"] before we capture history or call the
        # model — so the Step's recorded context reflects what the
        # model ACTUALLY saw, including the inject. One boolean check
        # of overhead when probe_enabled is False.
        if self._tracer.probe_enabled:
            req = apply_probe_to_request(
                self._tracer.run_id, req, self._tracer.probe_runtime
            )
        history = _flatten_history(req.get("messages") or [])
        system_prompt = _flatten_system(req.get("system"))
        step = self._tracer.start_step(
            model=req["model"],
            system_prompt=system_prompt,
            tool_definitions=req.get("tools"),
            history=history,
        )
        t0 = time.monotonic()
        try:
            resp = self._messages.create(**req)
        except Exception as exc:
            step.record_outcome(
                {
                    "status": "error",
                    "is_error": True,
                    "summary": _truncate(str(exc), 200),
                }
            )
            step.end()
            raise
        t1 = time.monotonic()

        action, decision = _action_from_response(resp)
        tokens = _tokens_from_response(resp)
        step.record_decision(decision=decision, action=action)
        step.record_tokens(
            input=tokens["input"],
            output=tokens["output"],
            cached_read=tokens["cached_read"],
            cache_creation=tokens["cache_creation"],
            cache_creation_1h=tokens.get("cache_creation_1h", 0),
            latency_ms=int((t1 - t0) * 1000),
        )
        step.record_outcome({"status": "ok"})
        step.end()
        return resp

    def __getattr__(self, name: str) -> Any:
        return getattr(self._messages, name)


# ---- response → step shape ----------------------------------------------


def _flatten_history(messages: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content")
        if isinstance(content, str):
            text = content
        else:
            # content blocks (list of dicts) — pull out text blocks only.
            parts: List[str] = []
            for b in content or []:
                if isinstance(b, dict) and b.get("type") == "text":
                    parts.append(str(b.get("text", "")))
            text = "\n".join(parts)
        # Spool's model accepts user/assistant/tool; map assistant↔assistant,
        # everything else to "user" (rare in Anthropic input shape).
        spool_role = "assistant" if role == "assistant" else "user"
        out.append({"role": spool_role, "content": text})
    return out


def _flatten_system(system: Any) -> Optional[str]:
    if system is None:
        return None
    if isinstance(system, str):
        return system
    # Anthropic permits list-of-blocks for system.
    if isinstance(system, list):
        parts: List[str] = []
        for b in system:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(str(b.get("text", "")))
        return "\n".join(parts) if parts else None
    return None


def _action_from_response(resp: Any) -> "tuple[Dict[str, Any], Any]":
    content = _attr(resp, "content") or []
    # Each block may be an SDK pydantic model OR a plain dict on test fakes.
    blocks: List[Dict[str, Any]] = []
    for b in content:
        if isinstance(b, dict):
            blocks.append(b)
        else:
            blocks.append(_to_plain(b))
    tool_use = next((b for b in blocks if b.get("type") == "tool_use"), None)
    text = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    if tool_use is not None:
        action = {
            "kind": "tool_call",
            "tool_name": tool_use.get("name"),
            "tool_use_id": tool_use.get("id"),
            "tool_input": tool_use.get("input"),
        }
    elif text:
        action = {"kind": "message", "text": text}
    else:
        action = {"kind": "thinking_only"}
    return action, blocks


def _tokens_from_response(resp: Any) -> Dict[str, int]:
    usage = _attr(resp, "usage")
    if usage is None:
        return {"input": 0, "output": 0, "cached_read": 0, "cache_creation": 0}
    # cache_creation breakdown (preferred path on newer SDKs).
    cc = _attr(usage, "cache_creation")
    if cc is not None:
        tokens_5m = int(_attr(cc, "ephemeral_5m_input_tokens") or 0)
        tokens_1h = int(_attr(cc, "ephemeral_1h_input_tokens") or 0)
    else:
        # Legacy: only the total is exposed — bucket it as 5m to avoid
        # silently undercharging on long-cache sessions.
        tokens_5m = int(_attr(usage, "cache_creation_input_tokens") or 0)
        tokens_1h = 0
    return {
        "input": int(_attr(usage, "input_tokens") or 0),
        "output": int(_attr(usage, "output_tokens") or 0),
        "cached_read": int(_attr(usage, "cache_read_input_tokens") or 0),
        "cache_creation": tokens_5m,
        "cache_creation_1h": tokens_1h,
    }


def _attr(obj: Any, key: str) -> Any:
    """Get attribute or dict key. Works for SDK pydantic models and plain dicts."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _to_plain(obj: Any) -> Dict[str, Any]:
    """Best-effort: pydantic .model_dump() or .dict() or vars()."""
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump()
        except Exception:
            pass
    if hasattr(obj, "dict"):
        try:
            return obj.dict()
        except Exception:
            pass
    try:
        return dict(vars(obj))
    except TypeError:
        return {"type": getattr(obj, "type", "unknown")}


def _truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n]
