import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

export function sessionJsonlPath(sessionId: string): string | null {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const filename = `${sessionId}.jsonl`;

  // Try the obvious slug first (/ → -). Use the active editor's workspace
  // folder so multi-root projects resolve correctly; fall back to folder[0]
  // then process.cwd().
  const cwd = preferredWorkspaceFolderFsPath() ?? process.cwd();
  const guess = path.join(projectsDir, cwd.replace(/\//g, "-"), filename);
  if (fs.existsSync(guess)) return guess;

  // Fallback: scan every project directory for the UUID.
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projectsDir, entry.name, filename);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}

export function preferredWorkspaceFolderFsPath(): string | null {
  const active = vscode.window.activeTextEditor?.document;
  if (active) {
    const folder = vscode.workspace.getWorkspaceFolder(active.uri);
    if (folder) return folder.uri.fsPath;
  }
  const first = vscode.workspace.workspaceFolders?.[0];
  return first ? first.uri.fsPath : null;
}

// Platform-aware shell quoting. POSIX on darwin/linux; PowerShell single-quote
// doubling on win32.
export function shellQuote(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    // PowerShell: escape single quotes by doubling them inside single-quoted
    // literal. Safer than cmd.exe quoting and works for tail-equivalent utils.
    return `'${p.replace(/'/g, "''")}'`;
  }
  return `'${p.replace(/'/g, "'\\''")}'`;
}
