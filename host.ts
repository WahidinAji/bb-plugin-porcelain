// bb-plugin-porcelain — full-trust host worker.
//
// The server entry (server.ts) resolves a thread's environment to an absolute
// worktree path and a hostId, then calls these methods over typed host RPC.
// Everything here is ordinary Node: we shell out to `git` in that directory.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
  hostContract,
  type ChangeCode,
  type FileChange,
  type GitStatus,
} from "./contract.js";

const GIT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_BYTES = 400 * 1024;
const MAX_MESSAGE_CHARS = 4_000;

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

function assertCwd(cwd: string): void {
  if (!cwd || !isAbsolute(cwd)) {
    throw new Error(`Invalid working directory: ${JSON.stringify(cwd)}`);
  }
}

function runGit(
  cwd: string,
  args: readonly string[],
  callSignal: AbortSignal,
  input?: string,
): Promise<GitRun> {
  const signal = AbortSignal.any([
    callSignal,
    AbortSignal.timeout(GIT_TIMEOUT_MS),
  ]);
  return new Promise<GitRun>((resolve, reject) => {
    const child = spawn("git", ["--no-pager", ...args], {
      cwd,
      signal,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let overflowed = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        overflowed = true;
        child.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") {
        reject(new Error("`git` was not found on this machine's PATH."));
        return;
      }
      reject(cause);
    });
    child.on("close", (code) => {
      if (overflowed) {
        reject(new Error("git produced more output than this plugin allows."));
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Run git and throw a readable error when it exits non-zero. */
async function git(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  input?: string,
): Promise<string> {
  const result = await runGit(cwd, args, signal, input);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, MAX_MESSAGE_CHARS);
    throw new Error(detail || `git ${args[0]} failed with code ${result.code}`);
  }
  return result.stdout;
}

function tidy(text: string): string {
  return text.trim().replace(/\s+$/gm, "").slice(0, MAX_MESSAGE_CHARS);
}

function mapCode(char: string): ChangeCode {
  switch (char) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "none";
  }
}

async function isInsideWorkTree(cwd: string, signal: AbortSignal): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], signal);
  return result.code === 0 && result.stdout.trim() === "true";
}

function parseStatus(
  raw: string,
): Omit<GitStatus, "isGitRepo" | "hasRemote" | "branches"> {
  const tokens = raw.split("\0");
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  const files: FileChange[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    if (!line) continue;

    if (line.startsWith("# ")) {
      const rest = line.slice(2);
      if (rest.startsWith("branch.head ")) {
        const head = rest.slice("branch.head ".length);
        if (head === "(detached)") {
          detached = true;
        } else {
          branch = head;
        }
      } else if (rest.startsWith("branch.upstream ")) {
        upstream = rest.slice("branch.upstream ".length);
      } else if (rest.startsWith("branch.ab ")) {
        const m = rest.slice("branch.ab ".length).match(/\+(\d+)\s+-(\d+)/);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      continue;
    }

    const kind = line[0];
    if (kind === "1") {
      const m = line.match(/^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s);
      if (!m) continue;
      files.push({
        path: m[2],
        origPath: null,
        staged: mapCode(m[1][0]),
        unstaged: mapCode(m[1][1]),
        isUntracked: false,
        isConflicted: false,
      });
    } else if (kind === "2") {
      const m = line.match(/^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s);
      if (!m) continue;
      const origPath = tokens[i + 1] ?? null;
      i += 1;
      files.push({
        path: m[2],
        origPath,
        staged: mapCode(m[1][0]),
        unstaged: mapCode(m[1][1]),
        isUntracked: false,
        isConflicted: false,
      });
    } else if (kind === "u") {
      const m = line.match(/^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s);
      if (!m) continue;
      files.push({
        path: m[2],
        origPath: null,
        staged: "unmerged",
        unstaged: "unmerged",
        isUntracked: false,
        isConflicted: true,
      });
    } else if (kind === "?") {
      files.push({
        path: line.slice(2),
        origPath: null,
        staged: "none",
        unstaged: "untracked",
        isUntracked: true,
        isConflicted: false,
      });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { branch, upstream, ahead, behind, detached, files };
}

async function untrackedPaths(
  cwd: string,
  candidates: readonly string[],
  signal: AbortSignal,
): Promise<Set<string>> {
  const raw = await git(
    cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...candidates],
    signal,
  );
  const set = new Set<string>();
  for (const token of raw.split("\0")) {
    if (token.startsWith("?? ")) set.add(token.slice(3));
  }
  return set;
}

export default experimental_defineHostEntry({
  contract: hostContract,

  handlers: {
    async status({ cwd }, { signal }) {
      assertCwd(cwd);
      if (!(await isInsideWorkTree(cwd, signal))) {
        return {
          isGitRepo: false,
          branch: null,
          detached: false,
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          branches: [],
          files: [],
        };
      }
      const raw = await git(
        cwd,
        [
          "status",
          "--porcelain=v2",
          "--branch",
          "-z",
          "--untracked-files=all",
        ],
        signal,
      );
      const remotes = await git(cwd, ["remote"], signal);
      const branchList = await git(
        cwd,
        [
          "for-each-ref",
          "--sort=-committerdate",
          "--format=%(refname:short)",
          "--count=200",
          "refs/heads/",
        ],
        signal,
      );
      const branches = branchList
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return {
        isGitRepo: true,
        hasRemote: remotes.trim().length > 0,
        branches,
        ...parseStatus(raw),
      };
    },

    async discoverRepos({ cwd, maxDepth }, { signal }) {
      assertCwd(cwd);

      if (await isInsideWorkTree(cwd, signal)) {
        const top = (
          await git(cwd, ["rev-parse", "--show-toplevel"], signal)
        ).trim();
        const branch =
          (
            await runGit(cwd, ["branch", "--show-current"], signal)
          ).stdout.trim() || null;
        return {
          rootIsRepo: true,
          repos: [{ relPath: ".", name: basename(top) || ".", branch }],
        };
      }

      const SKIP = new Set([
        "node_modules",
        ".git",
        "vendor",
        "dist",
        "build",
        "out",
        ".next",
        "target",
        ".venv",
        "venv",
        "__pycache__",
        ".cache",
        "coverage",
      ]);
      const MAX_REPOS = 50;
      const repos: {
        relPath: string;
        name: string;
        branch: string | null;
      }[] = [];

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (repos.length >= MAX_REPOS || depth > maxDepth) return;
        let entries: Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        if (entries.some((entry) => entry.name === ".git")) {
          const rel = relative(cwd, dir).split(sep).join("/") || ".";
          const branch =
            (
              await runGit(dir, ["branch", "--show-current"], signal)
            ).stdout.trim() || null;
          repos.push({ relPath: rel, name: rel.split("/").pop() || rel, branch });
          return; // a repo's own subtree is not scanned further
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
          await walk(join(dir, entry.name), depth + 1);
        }
      };

      await walk(cwd, 0);
      repos.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return { rootIsRepo: false, repos };
    },

    async diff({ cwd, path, origPath, staged }, { signal }) {
      assertCwd(cwd);
      let patch: string;
      if (staged) {
        const target = origPath ? [origPath, path] : [path];
        patch = await git(
          cwd,
          ["diff", "--cached", "--no-color", "--", ...target],
          signal,
        );
      } else {
        patch = await git(cwd, ["diff", "--no-color", "--", path], signal);
        if (patch.trim() === "") {
          const untracked = await untrackedPaths(cwd, [path], signal);
          if (untracked.has(path)) {
            const result = await runGit(
              cwd,
              ["diff", "--no-color", "--no-index", "--", "/dev/null", path],
              signal,
            );
            // `--no-index` exits 1 when files differ; that is the normal case.
            patch = result.stdout;
          }
        }
      }
      const binary =
        /^Binary files /m.test(patch) || patch.includes("GIT binary patch");
      let truncated = false;
      if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) {
        patch = patch.slice(0, MAX_PATCH_BYTES) + "\n\n… diff truncated …\n";
        truncated = true;
      }
      return { patch, binary, truncated };
    },

    async stage({ cwd, paths }, { signal }) {
      assertCwd(cwd);
      await git(cwd, ["add", "-A", "--", ...paths], signal);
      return { ok: true, message: `Staged ${paths.length} file(s).` };
    },

    async unstage({ cwd, paths }, { signal }) {
      assertCwd(cwd);
      const result = await runGit(
        cwd,
        ["restore", "--staged", "--", ...paths],
        signal,
      );
      if (result.code !== 0) {
        // No commits yet, or an old git: fall back to reset.
        await git(cwd, ["reset", "-q", "--", ...paths], signal);
      }
      return { ok: true, message: `Unstaged ${paths.length} file(s).` };
    },

    async discard({ cwd, paths }, { signal }) {
      assertCwd(cwd);
      const untracked = await untrackedPaths(cwd, paths, signal);
      const tracked = paths.filter((p) => !untracked.has(p));
      for (const rel of untracked) {
        await rm(join(cwd, rel), { recursive: true, force: true });
      }
      if (tracked.length > 0) {
        const result = await runGit(
          cwd,
          ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked],
          signal,
        );
        if (result.code !== 0) {
          // No HEAD yet: just drop them from the index.
          await git(cwd, ["restore", "--staged", "--", ...tracked], signal);
        }
      }
      return { ok: true, message: `Discarded ${paths.length} file(s).` };
    },

    async applyPatch({ cwd, patch, cached, reverse }, { signal }) {
      assertCwd(cwd);
      const args = ["apply", "--whitespace=nowarn"];
      if (cached) args.push("--cached");
      if (reverse) args.push("--reverse");
      args.push("--unidiff-zero", "-");
      const result = await runGit(cwd, args, signal, patch);
      if (result.code !== 0) {
        return { ok: false, message: tidy(result.stderr || result.stdout) };
      }
      return { ok: true, message: "Applied." };
    },

    async commit({ cwd, message, stageAll, amend }, { signal }) {
      assertCwd(cwd);
      if (stageAll) await git(cwd, ["add", "-A"], signal);
      const args = ["commit", "-m", message];
      if (amend) args.push("--amend");
      const result = await runGit(cwd, args, signal);
      if (result.code !== 0) {
        const text = (result.stdout + result.stderr).toLowerCase();
        if (text.includes("nothing to commit") || text.includes("no changes added")) {
          return {
            ok: false,
            message: "Nothing staged to commit.",
            commit: null,
          };
        }
        return {
          ok: false,
          message: tidy(result.stderr || result.stdout),
          commit: null,
        };
      }
      const head = (
        await runGit(cwd, ["rev-parse", "--short", "HEAD"], signal)
      ).stdout.trim();
      return {
        ok: true,
        message: `Committed ${head}.`,
        commit: head || null,
      };
    },

    async createBranch({ cwd, name, checkout }, { signal }) {
      assertCwd(cwd);
      const args = checkout ? ["switch", "-c", name] : ["branch", name];
      const result = await runGit(cwd, args, signal);
      if (result.code !== 0) {
        return { ok: false, message: tidy(result.stderr || result.stdout) };
      }
      return {
        ok: true,
        message: checkout ? `Switched to new branch ${name}.` : `Created branch ${name}.`,
      };
    },

    async switchBranch({ cwd, name }, { signal }) {
      assertCwd(cwd);
      const result = await runGit(cwd, ["switch", name], signal);
      if (result.code !== 0) {
        return { ok: false, message: tidy(result.stderr || result.stdout) };
      }
      return { ok: true, message: `Switched to ${name}.` };
    },

    async push({ cwd, remote, setUpstream, force }, { signal }) {
      assertCwd(cwd);
      const args = ["push"];
      if (force) args.push("--force-with-lease");
      if (setUpstream) args.push("--set-upstream", remote, "HEAD");
      const result = await runGit(cwd, args, signal);
      const output = tidy(result.stderr || result.stdout) || "Pushed.";
      return { ok: result.code === 0, message: output };
    },
  },
});
