import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Cursor's chat content lives in **global** storage, not workspace
 * storage:
 *
 *   macOS:   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   Linux:   ~/.config/Cursor/User/globalStorage/state.vscdb
 *   Windows: %APPDATA%\Cursor\User\globalStorage\state.vscdb
 *
 * Workspace storage holds layout state but not bubbles.
 */

export interface CursorPaths {
  globalStorage: string;
  workspaceStorage: string;
  globalDb: string;
}

export function cursorPaths(): CursorPaths {
  if (process.env.CURSOR_USER_DIR) {
    return {
      globalStorage: join(process.env.CURSOR_USER_DIR, "globalStorage"),
      workspaceStorage: join(process.env.CURSOR_USER_DIR, "workspaceStorage"),
      globalDb: join(process.env.CURSOR_USER_DIR, "globalStorage", "state.vscdb"),
    };
  }
  const home = homedir();
  let userDir: string;
  switch (platform()) {
    case "darwin":
      userDir = join(home, "Library", "Application Support", "Cursor", "User");
      break;
    case "win32":
      userDir = join(
        process.env.APPDATA ?? join(home, "AppData", "Roaming"),
        "Cursor",
        "User",
      );
      break;
    default:
      userDir = join(home, ".config", "Cursor", "User");
  }
  return {
    globalStorage: join(userDir, "globalStorage"),
    workspaceStorage: join(userDir, "workspaceStorage"),
    globalDb: join(userDir, "globalStorage", "state.vscdb"),
  };
}

export interface DiscoveredCursorWorkspace {
  workspace_id: string;
  path: string;
  size_bytes: number;
  mtime: Date;
  /** Path to its workspace.json which often contains the original folder URI. */
  workspace_json?: string;
}

/**
 * Walk workspaceStorage to map workspace_ids back to source directories
 * (so we can attribute composers to projects). Doesn't itself contain
 * chat bubbles.
 */
export async function discoverCursorWorkspaces(): Promise<
  DiscoveredCursorWorkspace[]
> {
  const root = cursorPaths().workspaceStorage;
  const out: DiscoveredCursorWorkspace[] = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(root, e);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    const wsJson = join(full, "workspace.json");
    out.push({
      workspace_id: e,
      path: full,
      size_bytes: s.size,
      mtime: s.mtime,
      workspace_json: existsSync(wsJson) ? wsJson : undefined,
    });
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

/** Extract the cwd of a workspace from its workspace.json (best-effort). */
export async function readWorkspaceCwd(
  ws: DiscoveredCursorWorkspace,
): Promise<string | undefined> {
  if (!ws.workspace_json) return undefined;
  try {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(ws.workspace_json, "utf-8");
    const obj = JSON.parse(buf) as { folder?: string };
    if (typeof obj.folder === "string") {
      // Cursor stores it as a file:// URI.
      return obj.folder.replace(/^file:\/\//, "");
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function defaultGlobalDbPath(): string {
  return cursorPaths().globalDb;
}
