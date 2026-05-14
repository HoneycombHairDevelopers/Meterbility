"""
Action / Outcome helpers — small constructors that keep caller code
tidy. Wire-format mirror of packages/shared/src/types.ts.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


def tool_call_action(
    name: str, tool_input: Any, tool_use_id: Optional[str] = None
) -> Dict[str, Any]:
    return {
        "kind": "tool_call",
        "tool_name": name,
        "tool_use_id": tool_use_id,
        "tool_input": tool_input,
    }


def message_action(text: str) -> Dict[str, Any]:
    return {"kind": "message", "text": text}


def thinking_only_action() -> Dict[str, Any]:
    return {"kind": "thinking_only"}


def sub_agent_action(sub_agent: str) -> Dict[str, Any]:
    return {"kind": "sub_agent_dispatch", "sub_agent": sub_agent}


def ok_outcome(
    summary: Optional[str] = None, tool_result_ref: Optional[str] = None
) -> Dict[str, Any]:
    out: Dict[str, Any] = {"status": "ok"}
    if summary is not None:
        out["summary"] = summary
    if tool_result_ref is not None:
        out["tool_result_ref"] = tool_result_ref
    return out


def error_outcome(
    summary: Optional[str] = None, is_error: bool = True
) -> Dict[str, Any]:
    out: Dict[str, Any] = {"status": "error", "is_error": is_error}
    if summary is not None:
        out["summary"] = summary
    return out


def pending_outcome() -> Dict[str, Any]:
    return {"status": "pending"}
