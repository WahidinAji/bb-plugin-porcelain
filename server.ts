// bb-plugin-porcelain — backend entry.
//
// A VS Code-style source-control surface for a thread's environment. The
// frontend panel (app.tsx) talks to these RPC methods; each one resolves the
// thread's environment to a worktree path + hostId and forwards a git
// operation to the full-trust host worker (host.ts). Any mutation publishes a
// realtime signal so every open panel for that thread refetches.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, gitStatusSchema } from "./contract.js";

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
      status: gitStatusSchema,
    }),
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

  /** Resolve + assert a local worktree, then return host call context. */
  async function workspace(threadId: string) {
    const { environmentId, hostId, workspacePath } = await locate(threadId);
    if (!workspacePath) {
      throw new Error(
        "This thread's environment has no local working directory.",
      );
    }
    return { environmentId, hostId, cwd: workspacePath };
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
          status: {
            isGitRepo: false,
            branch: null,
            detached: false,
            upstream: null,
            ahead: 0,
            behind: 0,
            hasRemote: false,
            files: [],
          },
        };
      }
      const status = await host.call(
        "status",
        { cwd: workspacePath },
        { hostId },
      );
      return { environmentId, hostId, workspacePath, status };
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
