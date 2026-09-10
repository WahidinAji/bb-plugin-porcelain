// bb-plugin-porcelain — backend entry.
//
// A VS Code-style source-control surface for a thread's environment. The
// frontend panel (app.tsx) talks to these RPC methods; each one resolves the
// thread's environment to a worktree path + hostId and forwards a git
// operation to the full-trust host worker (host.ts). Any mutation publishes a
// realtime signal so every open panel for that thread refetches.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { hostContract, gitStatusSchema, repoEntrySchema } from "./contract.js";

const thread = z.object({ threadId: z.string().min(1) });
const paths = z.array(z.string().min(1)).min(1).max(2000);
const actionResult = z.object({ ok: z.boolean(), message: z.string() });

export const rpcContract = defineRpcContract({
  status: {
    input: thread.strict(),
    output: z.object({
      environmentId: z.string(),
      hostId: z.string(),
      workspacePath: z.string().nullable(),
      /** True when the environment root is itself a git worktree. */
      rootIsRepo: z.boolean(),
      /** Repos the panel can target (the root, or nested ones). */
      repos: z.array(repoEntrySchema),
      /** Which repo is active: "" (none chosen), "." (root), or a relPath. */
      selectedRelPath: z.string(),
      status: gitStatusSchema,
    }),
  },
  selectRepo: {
    input: thread.extend({ relPath: z.string() }).strict(),
    output: actionResult,
  },
  diff: {
    input: thread
      .extend({
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
  stage: { input: thread.extend({ paths }).strict(), output: actionResult },
  unstage: { input: thread.extend({ paths }).strict(), output: actionResult },
  discard: { input: thread.extend({ paths }).strict(), output: actionResult },
  // Hunk-level staging. The frontend builds a one-hunk patch and picks a mode:
  //   stage   → cached, forward           unstage → cached, reverse
  //   revert  → worktree, reverse
  stageHunk: {
    input: thread.extend({ patch: z.string().min(1) }).strict(),
    output: actionResult,
  },
  unstageHunk: {
    input: thread.extend({ patch: z.string().min(1) }).strict(),
    output: actionResult,
  },
  revertHunk: {
    input: thread.extend({ patch: z.string().min(1) }).strict(),
    output: actionResult,
  },
  commit: {
    input: thread
      .extend({
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
    input: thread
      .extend({
        name: z.string().trim().min(1).max(255),
        checkout: z.boolean().default(true),
      })
      .strict(),
    output: actionResult,
  },
  push: {
    input: thread
      .extend({
        setUpstream: z.boolean().default(false),
        force: z.boolean().default(false),
      })
      .strict(),
    output: actionResult,
  },
});

const channel = (threadId: string): string => `porcelain:${threadId}`;
const repoKey = (threadId: string): string => `repo:${threadId}`;
const DISCOVER_DEPTH = 3;

const EMPTY_STATUS = {
  isGitRepo: false,
  branch: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  hasRemote: false,
  files: [] as never[],
};

/** Join a chosen sub-repo onto the env root, refusing anything that escapes it. */
function repoDir(root: string, relPath: string): string {
  if (!relPath || relPath === ".") return root;
  const base = resolve(root);
  const target = resolve(root, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error("Selected directory is outside the workspace.");
  }
  return target;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const host = bb.hosts.experimental_client({ contract: hostContract });

  /** thread → { environment id, host, absolute worktree path }. */
  async function locate(threadId: string) {
    const t = await bb.sdk.threads.get({ threadId });
    const environmentId = t.environmentId;
    if (!environmentId) {
      throw new Error("This thread is not attached to an environment.");
    }
    const env = await bb.sdk.environments.get({ environmentId });
    return { environmentId, hostId: env.hostId, workspacePath: env.path };
  }

  /**
   * Resolve the git directory this thread's panel currently targets: the
   * environment root, or the nested repo the user picked (stored in kv).
   */
  async function workspace(threadId: string) {
    const { environmentId, hostId, workspacePath } = await locate(threadId);
    if (!workspacePath) {
      throw new Error(
        "This thread's environment has no local working directory.",
      );
    }
    const selected = (await bb.storage.kv.get<string>(repoKey(threadId))) ?? "";
    return {
      environmentId,
      hostId,
      cwd: repoDir(workspacePath, selected),
    };
  }

  function notify(threadId: string): void {
    bb.realtime.publish(channel(threadId), { at: Date.now() });
  }

  bb.rpc.register(rpcContract, {
    async status({ threadId }) {
      const { environmentId, hostId, workspacePath } = await locate(threadId);
      if (!workspacePath) {
        return {
          environmentId,
          hostId,
          workspacePath: null,
          rootIsRepo: false,
          repos: [],
          selectedRelPath: "",
          status: EMPTY_STATUS,
        };
      }

      const discovered = await host.call(
        "discoverRepos",
        { cwd: workspacePath, maxDepth: DISCOVER_DEPTH },
        { hostId },
      );

      let selected =
        (await bb.storage.kv.get<string>(repoKey(threadId))) ?? "";
      if (discovered.rootIsRepo) {
        selected = ".";
      } else {
        const known = new Set(discovered.repos.map((r) => r.relPath));
        if (!known.has(selected)) {
          // Auto-pick when there is exactly one; otherwise wait for a choice.
          selected =
            discovered.repos.length === 1 ? discovered.repos[0].relPath : "";
          if (selected) await bb.storage.kv.set(repoKey(threadId), selected);
        }
      }

      const base = {
        environmentId,
        hostId,
        workspacePath,
        rootIsRepo: discovered.rootIsRepo,
        repos: discovered.repos,
        selectedRelPath: selected,
      };

      if (!discovered.rootIsRepo && selected === "") {
        return { ...base, status: EMPTY_STATUS };
      }

      const status = await host.call(
        "status",
        { cwd: repoDir(workspacePath, selected) },
        { hostId },
      );
      return { ...base, status };
    },

    async selectRepo({ threadId, relPath }) {
      const { hostId, workspacePath } = await locate(threadId);
      if (!workspacePath) {
        return { ok: false, message: "No local working directory." };
      }
      const discovered = await host.call(
        "discoverRepos",
        { cwd: workspacePath, maxDepth: DISCOVER_DEPTH },
        { hostId },
      );
      const allowed = new Set<string>([
        "",
        ".",
        ...discovered.repos.map((r) => r.relPath),
      ]);
      if (!allowed.has(relPath)) {
        return { ok: false, message: "Unknown directory." };
      }
      const stored = relPath || (discovered.rootIsRepo ? "." : "");
      await bb.storage.kv.set(repoKey(threadId), stored);
      notify(threadId);
      return {
        ok: true,
        message:
          stored && stored !== "."
            ? `Now tracking ${stored}.`
            : "Now tracking the workspace root.",
      };
    },

    async diff({ threadId, path, origPath, staged }) {
      const { hostId, cwd } = await workspace(threadId);
      return host.call(
        "diff",
        { cwd, path, origPath, staged },
        { hostId },
      );
    },

    async stage({ threadId, paths: files }) {
      const { hostId, cwd } = await workspace(threadId);
      const result = await host.call("stage", { cwd, paths: files }, { hostId });
      notify(threadId);
      return result;
    },

    async unstage({ threadId, paths: files }) {
      const { hostId, cwd } = await workspace(threadId);
      const result = await host.call(
        "unstage",
        { cwd, paths: files },
        { hostId },
      );
      notify(threadId);
      return result;
    },

    async discard({ threadId, paths: files }) {
      const { hostId, cwd } = await workspace(threadId);
      const result = await host.call(
        "discard",
        { cwd, paths: files },
        { hostId },
      );
      notify(threadId);
      return result;
    },

    async stageHunk({ threadId, patch }) {
      const { hostId, cwd } = await workspace(threadId);
      const result = await host.call(
        "applyPatch",
        { cwd, patch, cached: true, reverse: false },
        { hostId },
      );
      notify(threadId);
      return result;
    },

    async unstageHunk({ threadId, patch }) {
      const { hostId, cwd } = await workspace(threadId);
      const result = await host.call(
        "applyPatch",
        { cwd, patch, cached: true, reverse: true },
        { hostId },
      );
      notify(threadId);
      return result;
    },

    async revertHunk({ threadId, patch }) {
      const { hostId, cwd } = await workspace(threadId);
      const result = await host.call(
        "applyPatch",
        { cwd, patch, cached: false, reverse: true },
        { hostId },
      );
      notify(threadId);
      return result;
    },

    async commit({ threadId, message, stageAll, amend }) {
      const { hostId, cwd } = await workspace(threadId);
      const result = await host.call(
        "commit",
        { cwd, message, stageAll, amend },
        { hostId },
      );
      notify(threadId);
      return result;
    },

    async createBranch({ threadId, name, checkout }) {
      const { hostId, cwd } = await workspace(threadId);
      const result = await host.call(
        "createBranch",
        { cwd, name, checkout },
        { hostId },
      );
      notify(threadId);
      return result;
    },

    async push({ threadId, setUpstream, force }) {
      const { hostId, cwd } = await workspace(threadId);
      const result = await host.call(
        "push",
        { cwd, remote: "origin", setUpstream, force },
        { hostId },
      );
      notify(threadId);
      return result;
    },
  });

  // Nudge open panels to refetch around agent activity — the working tree
  // typically changes across a turn.
  bb.events.on("thread.idle", ({ thread: t }) => notify(t.id));
  bb.events.on("thread.active", ({ thread: t }) => notify(t.id));

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
