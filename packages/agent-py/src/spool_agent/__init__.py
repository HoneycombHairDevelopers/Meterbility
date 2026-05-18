"""
Spool Python SDK.

Wire any Python agent into Spool by capturing one Step per model call.
Runs land in the same ``~/.spool/spool.db`` SQLite store the TypeScript
SDK, the CLI, and the web UI read from — so a Python agent shows up in
``spool list`` and ``spool web`` immediately, no separate ingest step.

Minimal usage::

    from spool_agent import SpoolTracer

    tracer = SpoolTracer(project="my-app", agent="support")
    step = tracer.start_step(
        model="claude-opus-4-7",
        system_prompt="you are helpful",
        history=[{"role": "user", "content": "hello"}],
    )
    step.record_message("hi!")
    step.record_tokens(input=10, output=2, cached_read=0, cache_creation=0)
    step.end()
    tracer.end()

Anthropic shortcut::

    from anthropic import Anthropic
    from spool_agent import SpoolTracer, trace_anthropic

    tracer = SpoolTracer(project="my-app", agent="support")
    client = Anthropic()
    traced = trace_anthropic(tracer, client)

    resp = traced.messages.create(
        model="claude-opus-4-7",
        max_tokens=512,
        messages=[{"role": "user", "content": "hello"}],
    )
"""

from .tracer import SpoolTracer, SpoolStep
from .anthropic_helper import trace_anthropic
from .actions import (
    tool_call_action,
    message_action,
    thinking_only_action,
    sub_agent_action,
)
from .paths import spool_home, db_path, blob_root, blob_path
from .probe import (
    ProbeRecord,
    ProbeState,
    clear_probe,
    confirm_paused,
    consume_inject,
    probe_dir,
    probe_file_path,
    read_state,
    request_pause,
    request_resume,
    set_inject,
)
from .probe_hook import DEFAULT_PROBE_RUNTIME, ProbeRuntime, apply_probe_to_request

__all__ = [
    "SpoolTracer",
    "SpoolStep",
    "trace_anthropic",
    "tool_call_action",
    "message_action",
    "thinking_only_action",
    "sub_agent_action",
    "spool_home",
    "db_path",
    "blob_root",
    "blob_path",
    # Probe protocol (cross-language file format).
    "ProbeRecord",
    "ProbeState",
    "clear_probe",
    "confirm_paused",
    "consume_inject",
    "probe_dir",
    "probe_file_path",
    "read_state",
    "request_pause",
    "request_resume",
    "set_inject",
    # Probe SDK hook.
    "ProbeRuntime",
    "DEFAULT_PROBE_RUNTIME",
    "apply_probe_to_request",
]

__version__ = "0.1.0"
