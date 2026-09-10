// Shared runtime contract between server.ts (loopback RPC caller) and host.ts
// (full-trust Node worker that shells out to `git`). Both sides import this
// file; the schemas run at the host RPC boundary.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** How a single path changed, on one side of the index. */
export const changeCodeSchema = z.enum([
  "none",
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "untracked",
  "unmerged",
]);
export type ChangeCode = z.infer<typeof changeCodeSchema>;

export const fileChangeSchema = z.object({
  /** Worktree-relative path (the new path for a rename). */
  path: z.string(),
  /** Previous path for a rename/copy, else null. */
  origPath: z.string().nullable(),
  /** Staged (index vs HEAD) status. */
  staged: changeCodeSchema,
  /** Unstaged (worktree vs index) status. */
  unstaged: changeCodeSchema,
  isUntracked: z.boolean(),
  isConflicted: z.boolean(),
});
export type FileChange = z.infer<typeof fileChangeSchema>;

export const gitStatusSchema = z.object({
  isGitRepo: z.boolean(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  hasRemote: z.boolean(),
  /** Local branch names, most-recently-committed first. */
  branches: z.array(z.string()),
  /** Remote-tracking branch names (e.g. "origin/feature"), HEAD excluded. */
  remoteBranches: z.array(z.string()),
  files: z.array(fileChangeSchema),
});
export type GitStatus = z.infer<typeof gitStatusSchema>;

const cwd = z.string().min(1);
const paths = z.array(z.string().min(1)).min(1).max(2000);
const actionResult = z.object({ ok: z.boolean(), message: z.string() });

export const repoEntrySchema = z.object({
  /** Path relative to the environment root; "." when the root itself is a repo. */
  relPath: z.string(),
  name: z.string(),
  branch: z.string().nullable(),
});
export type RepoEntry = z.infer<typeof repoEntrySchema>;

export const hostContract = defineRpcContract({
  status: {
    input: z.object({ cwd }).strict(),
    output: gitStatusSchema,
  },
  // Find the git repo(s) a Changes panel can target. If `cwd` is itself a
  // worktree, that is the only answer. Otherwise scan a few levels down for
  // nested repos (a "projects folder" layout) and let the user pick one.
  discoverRepos: {
    input: z
      .object({ cwd, maxDepth: z.number().int().min(1).max(4).default(3) })
      .strict(),
    output: z.object({
      rootIsRepo: z.boolean(),
      repos: z.array(repoEntrySchema),
    }),
  },
  diff: {
    input: z
      .object({
        cwd,
        path: z.string().min(1),
        origPath: z.string().nullable().default(null),
        staged: z.boolean(),
      })
      .strict(),
    output: z.object({
      patch: z.string(),
      binary: z.boolean(),
      truncated: z.boolean(),
    }),
  },
  stage: { input: z.object({ cwd, paths }).strict(), output: actionResult },
  unstage: { input: z.object({ cwd, paths }).strict(), output: actionResult },
  discard: { input: z.object({ cwd, paths }).strict(), output: actionResult },
  // Hunk-level staging: apply a caller-built partial patch to the index or
  // worktree. `cached` targets the index; `reverse` unstages / reverts.
  applyPatch: {
    input: z
      .object({
        cwd,
        patch: z.string().min(1).max(1_000_000),
        cached: z.boolean(),
        reverse: z.boolean(),
      })
      .strict(),
    output: actionResult,
  },
  commit: {
    input: z
      .object({
        cwd,
        message: z.string().min(1).max(20_000),
        stageAll: z.boolean().default(false),
        amend: z.boolean().default(false),
      })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      commit: z.string().nullable(),
    }),
  },
  createBranch: {
    input: z
      .object({
        cwd,
        name: z.string().min(1).max(255),
        checkout: z.boolean().default(true),
      })
      .strict(),
    output: actionResult,
  },
  switchBranch: {
    input: z.object({ cwd, name: z.string().min(1).max(255) }).strict(),
    output: actionResult,
  },
  push: {
    input: z
      .object({
        cwd,
        remote: z.string().min(1).default("origin"),
        setUpstream: z.boolean().default(false),
        force: z.boolean().default(false),
      })
      .strict(),
    output: actionResult,
  },
});
