"""
SQL helpers — mirror the subset of packages/collector/src/queries.ts
that the SDK needs (writes only: projects, agents, runs, steps,
context_snapshots).
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def now_iso() -> str:
    """ISO-8601 UTC with millisecond precision, matching TS ``new Date().toISOString()``."""
    dt = datetime.now(timezone.utc)
    ms = f"{dt.microsecond // 1000:03d}"
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + ms + "Z"


def upsert_project_by_cwd(
    db: sqlite3.Connection, cwd: str, name: Optional[str] = None
) -> Dict[str, str]:
    row = db.execute(
        "SELECT project_id, name, cwd, created_at FROM projects WHERE cwd = ?",
        (cwd,),
    ).fetchone()
    if row:
        return {
            "project_id": row[0],
            "name": row[1],
            "cwd": row[2],
            "created_at": row[3],
        }
    project_id = f"prj_{uuid.uuid4()}"
    pname = name or (cwd.rstrip("/").split("/")[-1] or cwd)
    created_at = now_iso()
    db.execute(
        "INSERT INTO projects(project_id, name, cwd, created_at) VALUES(?,?,?,?)",
        (project_id, pname, cwd, created_at),
    )
    return {
        "project_id": project_id,
        "name": pname,
        "cwd": cwd,
        "created_at": created_at,
    }


def upsert_agent(
    db: sqlite3.Connection, project_id: str, name: str
) -> Dict[str, str]:
    row = db.execute(
        "SELECT agent_id, project_id, name, created_at FROM agents "
        "WHERE project_id = ? AND name = ?",
        (project_id, name),
    ).fetchone()
    if row:
        return {
            "agent_id": row[0],
            "project_id": row[1],
            "name": row[2],
            "created_at": row[3],
        }
    agent_id = f"agt_{uuid.uuid4()}"
    created_at = now_iso()
    db.execute(
        "INSERT INTO agents(agent_id, project_id, name, created_at) "
        "VALUES(?,?,?,?)",
        (agent_id, project_id, name, created_at),
    )
    return {
        "agent_id": agent_id,
        "project_id": project_id,
        "name": name,
        "created_at": created_at,
    }


def insert_run(db: sqlite3.Connection, run: Dict[str, Any]) -> None:
    db.execute(
        """
        INSERT INTO runs(
          run_id, agent_id, project_id, source_session_id, source_runtime,
          title, status, started_at, ended_at, git_branch, cwd,
          fork_origin_run_id, fork_origin_step_id,
          tokens_total_input, tokens_total_output, tokens_total_cached,
          cost_cents, step_count, tags
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            run["run_id"],
            run["agent_id"],
            run["project_id"],
            run.get("source_session_id"),
            run["source_runtime"],
            run.get("title"),
            run["status"],
            run["started_at"],
            run.get("ended_at"),
            run.get("git_branch"),
            run.get("cwd"),
            run.get("fork_origin_run_id"),
            run.get("fork_origin_step_id"),
            run.get("tokens_total_input", 0),
            run.get("tokens_total_output", 0),
            run.get("tokens_total_cached", 0),
            run.get("cost_cents", 0),
            run.get("step_count", 0),
            json.dumps(run.get("tags") or []),
        ),
    )


def set_run_status(
    db: sqlite3.Connection,
    run_id: str,
    status: str,
    ended_at: Optional[str] = None,
) -> None:
    db.execute(
        "UPDATE runs SET status = ?, ended_at = ? WHERE run_id = ?",
        (status, ended_at, run_id),
    )


def update_run_totals(db: sqlite3.Connection, run_id: str) -> None:
    db.execute(
        """
        UPDATE runs SET
          step_count = (SELECT COUNT(*) FROM steps WHERE run_id = runs.run_id),
          tokens_total_input = COALESCE(
            (SELECT SUM(tokens_input) FROM steps WHERE run_id = runs.run_id), 0),
          tokens_total_output = COALESCE(
            (SELECT SUM(tokens_output) FROM steps WHERE run_id = runs.run_id), 0),
          tokens_total_cached = COALESCE(
            (SELECT SUM(tokens_cached_read + tokens_cache_creation + tokens_cache_creation_1h)
              FROM steps WHERE run_id = runs.run_id), 0),
          cost_cents = COALESCE(
            (SELECT SUM(cost_cents) FROM steps WHERE run_id = runs.run_id), 0)
        WHERE run_id = ?
        """,
        (run_id,),
    )


def insert_step(db: sqlite3.Connection, step: Dict[str, Any]) -> None:
    tokens = step["tokens"]
    db.execute(
        """
        INSERT OR REPLACE INTO steps(
          step_id, run_id, parent_step_id, fork_origin_id, sequence, timestamp,
          model, context_snapshot_id, decision_ref, action_json, outcome_json,
          tokens_input, tokens_output, tokens_cached_read, tokens_cache_creation,
          tokens_cache_creation_1h, tokens_reasoning, latency_ms, cost_cents,
          status, tags
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            step["step_id"],
            step["run_id"],
            step.get("parent_step_id"),
            step.get("fork_origin_id"),
            step["sequence"],
            step["timestamp"],
            step["model"],
            step["context_snapshot_id"],
            step["decision_ref"],
            json.dumps(step["action"]),
            json.dumps(step["outcome"]),
            tokens.get("input", 0),
            tokens.get("output", 0),
            tokens.get("cached_read", 0),
            tokens.get("cache_creation", 0),
            tokens.get("cache_creation_1h", 0),
            tokens.get("reasoning"),
            step.get("latency_ms", 0),
            step.get("cost_cents", 0),
            step["status"],
            json.dumps(step.get("tags") or []),
        ),
    )


def record_context_snapshot(
    db: sqlite3.Connection,
    snapshot_id: str,
    blob_ref: str,
    component_count: int,
) -> None:
    db.execute(
        """
        INSERT OR IGNORE INTO context_snapshots(
          snapshot_id, blob_ref, component_count, created_at
        ) VALUES (?,?,?,?)
        """,
        (snapshot_id, blob_ref, component_count, now_iso()),
    )
