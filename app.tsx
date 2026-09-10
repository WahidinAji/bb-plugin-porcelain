// bb-plugin-porcelain — frontend entry.
//
// A VS Code-style Source Control surface for a thread's environment:
//   • "Changes" tab in the thread's right panel (flush layout, owns its UI)
//   • a compact branch/count button in the thread header that opens it
//
// All git work happens in server.ts → host.ts. This file is pure view +
// the RPC calls that drive it, kept live by the "porcelain:<threadId>" signal.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_Diff as Diff,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginThreadHeaderActionProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { ChangeCode, FileChange, GitStatus, RepoEntry } from "./contract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Contract = typeof rpcContract;
interface StatusResult {
  environmentId: string;
  hostId: string;
  workspacePath: string | null;
  rootIsRepo: boolean;
  repos: RepoEntry[];
  selectedRelPath: string;
  status: GitStatus;
}

const repoLabel = (repo: RepoEntry): string =>
  (repo.relPath === "." ? "workspace root" : repo.relPath) +
  (repo.branch ? ` · ${repo.branch}` : "");
interface DiffResult {
  patch: string;
  binary: boolean;
  truncated: boolean;
}
interface Selection {
  path: string;
  origPath: string | null;
  staged: boolean;
}
type Notice = { kind: "error" | "info"; text: string } | null;

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1
    ? { dir: "", base: path }
    : { dir: path.slice(0, idx), base: path.slice(idx + 1) };
}

const STATUS_LETTER: Record<ChangeCode, string> = {
  none: "•",
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "type-changed": "T",
  untracked: "U",
  unmerged: "!",
};

function toneClass(code: ChangeCode): string {
  if (code === "deleted" || code === "unmerged") return "text-destructive";
  if (code === "added" || code === "untracked" || code === "copied")
    return "text-primary";
  return "text-muted-foreground";
}

/** Working-tree status for a thread, kept current by the realtime signal. */
function useChanges(threadId: string) {
  const rpc = useRpc<Contract>();
  const [data, setData] = useState<StatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++seq.current;
    rpc.call("status", { threadId }).then(
      (result) => {
        if (mine !== seq.current) return;
        setData(result as StatusResult);
        setError(null);
        setLoading(false);
      },
      (cause) => {
        if (mine !== seq.current) return;
        setError(errorText(cause));
        setLoading(false);
      },
    );
  }, [rpc, threadId]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  useRealtime(`porcelain:${threadId}`, refresh);

  useEffect(() => {
    const onWake = () => refresh();
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [refresh]);

  return { rpc, data, error, loading, refresh };
}

function RowAction({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function FileRow({
  file,
  side,
  active,
  disabled,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: {
  file: FileChange;
  side: "staged" | "unstaged";
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}) {
  const code = side === "staged" ? file.staged : file.unstaged;
  const { dir, base } = splitPath(file.path);
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          "group flex cursor-pointer items-center gap-2 px-3 py-1 outline-none",
          active ? "bg-state-active" : "hover:bg-state-hover",
        )}
      >
        <span
          className={cn(
            "w-3 shrink-0 text-center font-mono text-xs font-semibold",
            toneClass(code),
          )}
          title={code}
        >
          {STATUS_LETTER[code]}
        </span>
        <span
          className={cn(
            "truncate",
            code === "deleted" && "text-muted-foreground line-through",
          )}
        >
          {base}
        </span>
        {dir ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {dir}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          {side === "staged" ? (
            <RowAction label="Unstage" onClick={onUnstage} disabled={disabled} />
          ) : (
            <>
              <RowAction
                label="Discard"
                onClick={onDiscard}
                disabled={disabled}
              />
              <RowAction label="Stage" onClick={onStage} disabled={disabled} />
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function Group({
  title,
  count,
  headerAction,
  children,
}: {
  title: string;
  count: number;
  headerAction?: { label: string; onClick: () => void; disabled?: boolean };
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section>
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-background/95 px-3 py-1.5 backdrop-blur">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <span className="rounded bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
        {headerAction ? (
          <button
            type="button"
            disabled={headerAction.disabled}
            onClick={headerAction.onClick}
            className="ml-auto rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-40"
          >
            {headerAction.label}
          </button>
        ) : null}
      </div>
      <ul>{children}</ul>
    </section>
  );
}

function ChangesPanel({ threadId }: PluginThreadPanelProps) {
  const { rpc, data, error, loading, refresh } = useChanges(threadId);

  const [selected, setSelected] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffView, setDiffView] = useState<"unified" | "split">("unified");
  const [commitMessage, setCommitMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [pendingDiscard, setPendingDiscard] = useState<string[] | null>(null);

  const status = data?.status;
  const repos = data?.repos ?? [];
  const selectedRepo = data?.selectedRelPath ?? "";
  const rootIsRepo = data?.rootIsRepo ?? false;
  const showRepoPicker = repos.length > 1 || (!rootIsRepo && repos.length >= 1);
  const files = status?.files ?? [];
  const stagedFiles = useMemo(
    () => files.filter((f) => f.staged !== "none" && f.staged !== "untracked"),
    [files],
  );
  const unstagedFiles = useMemo(
    () => files.filter((f) => f.unstaged !== "none"),
    [files],
  );

  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    rpc
      .call("diff", {
        threadId,
        path: selected.path,
        origPath: selected.origPath,
        staged: selected.staged,
      })
      .then(
        (result) => {
          if (cancelled) return;
          setDiff(result as DiffResult);
          setDiffLoading(false);
        },
        (cause) => {
          if (cancelled) return;
          setDiff({ patch: "", binary: false, truncated: false });
          setDiffLoading(false);
          setNotice({ kind: "error", text: errorText(cause) });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, selected, data]);

  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(label);
      setNotice(null);
      try {
        const result = await fn();
        const maybe = result as { ok?: boolean; message?: string } | undefined;
        if (maybe && maybe.ok === false) {
          setNotice({ kind: "error", text: maybe.message ?? "Failed." });
        } else if (maybe && maybe.message) {
          setNotice({ kind: "info", text: maybe.message });
        }
        return result;
      } catch (cause) {
        setNotice({ kind: "error", text: errorText(cause) });
        return undefined;
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [refresh],
  );

  const stage = (paths: string[]) =>
    void run("stage", () => rpc.call("stage", { threadId, paths }));
  const unstage = (paths: string[]) =>
    void run("unstage", () => rpc.call("unstage", { threadId, paths }));

  const switchRepo = async (relPath: string) => {
    if (relPath === selectedRepo || busy) return;
    setSelected(null);
    setCommitMessage("");
    await run("repo", () => rpc.call("selectRepo", { threadId, relPath }));
  };

  const confirmDiscard = async () => {
    if (!pendingDiscard) return;
    const paths = pendingDiscard;
    setPendingDiscard(null);
    await run("discard", () => rpc.call("discard", { threadId, paths }));
    if (selected && paths.includes(selected.path)) setSelected(null);
  };

  const commit = async () => {
    const message = commitMessage.trim();
    if (!message || busy) return;
    const result = await run("commit", () =>
      rpc.call("commit", {
        threadId,
        message,
        stageAll: stagedFiles.length === 0,
      }),
    );
    if (result && (result as { ok: boolean }).ok) setCommitMessage("");
  };

  const push = () => {
    if (busy) return;
    void run("push", () =>
      rpc.call("push", {
        threadId,
        setUpstream: status?.upstream == null,
      }),
    );
  };

  const submitBranch = async () => {
    const name = branchName.trim();
    if (!name) return;
    const result = await run("branch", () =>
      rpc.call("createBranch", { threadId, name, checkout: true }),
    );
    if (result && (result as { ok: boolean }).ok) {
      setBranchOpen(false);
      setBranchName("");
    }
  };

  const isSelected = (file: FileChange, side: "staged" | "unstaged") =>
    selected?.path === file.path && selected.staged === (side === "staged");

  const select = (file: FileChange, side: "staged" | "unstaged") =>
    setSelected({
      path: file.path,
      origPath: file.origPath,
      staged: side === "staged",
    });

  let body: React.ReactNode;
  if (loading && !data) {
    body = <Centered>Loading changes…</Centered>;
  } else if (error) {
    body = <Centered tone="error">{error}</Centered>;
  } else if (data && data.workspacePath === null) {
    body = <Centered>This thread has no local working directory.</Centered>;
  } else if (!rootIsRepo && repos.length === 0) {
    body = <Centered>No Git repository found in this workspace.</Centered>;
  } else if (!status?.isGitRepo && selectedRepo === "") {
    body = (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
        <p className="text-center text-sm text-muted-foreground">
          This workspace has no Git repo at its root, but{" "}
          {repos.length === 1 ? "one was" : `${repos.length} were`} found
          inside. Pick one to manage:
        </p>
        <div className="flex w-full max-w-sm flex-col gap-1">
          {repos.map((repo) => (
            <button
              key={repo.relPath}
              type="button"
              disabled={busy !== null}
              onClick={() => void switchRepo(repo.relPath)}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left hover:bg-state-hover disabled:opacity-50"
            >
              <span className="truncate text-sm">
                {repo.relPath === "." ? "workspace root" : repo.relPath}
              </span>
              {repo.branch ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {repo.branch}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    );
  } else if (status && !status.isGitRepo) {
    body = <Centered>Not a Git repository.</Centered>;
  } else if (files.length === 0) {
    body = <Centered>No changes in the working tree.</Centered>;
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className={cn(
            "min-h-0 overflow-y-auto",
            selected
              ? "h-1/2 shrink-0 border-b border-border"
              : "flex-1",
          )}
        >
          <Group
            title="Staged Changes"
            count={stagedFiles.length}
            headerAction={{
              label: "Unstage All",
              disabled: busy !== null,
              onClick: () => unstage(stagedFiles.map((f) => f.path)),
            }}
          >
            {stagedFiles.map((file) => (
              <FileRow
                key={`s:${file.path}`}
                file={file}
                side="staged"
                active={isSelected(file, "staged")}
                disabled={busy !== null}
                onSelect={() => select(file, "staged")}
                onStage={() => stage([file.path])}
                onUnstage={() => unstage([file.path])}
                onDiscard={() => setPendingDiscard([file.path])}
              />
            ))}
          </Group>
          <Group
            title="Changes"
            count={unstagedFiles.length}
            headerAction={{
              label: "Stage All",
              disabled: busy !== null,
              onClick: () => stage(unstagedFiles.map((f) => f.path)),
            }}
          >
            {unstagedFiles.map((file) => (
              <FileRow
                key={`u:${file.path}`}
                file={file}
                side="unstaged"
                active={isSelected(file, "unstaged")}
                disabled={busy !== null}
                onSelect={() => select(file, "unstaged")}
                onStage={() => stage([file.path])}
                onUnstage={() => unstage([file.path])}
                onDiscard={() => setPendingDiscard([file.path])}
              />
            ))}
          </Group>
        </div>

        {selected ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              <span className="truncate text-xs font-medium">
                {selected.path}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() =>
                    setDiffView((v) => (v === "unified" ? "split" : "unified"))
                  }
                  className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
                >
                  {diffView === "unified" ? "Split" : "Unified"}
                </button>
                <button
                  type="button"
                  aria-label="Close diff"
                  onClick={() => setSelected(null)}
                  className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {diffLoading ? (
                <p className="p-4 text-xs text-muted-foreground">Loading diff…</p>
              ) : diff?.binary ? (
                <p className="p-4 text-xs text-muted-foreground">
                  Binary file — no textual diff.
                </p>
              ) : diff && diff.patch.trim() !== "" ? (
                <Diff
                  patch={diff.patch}
                  path={selected.path}
                  view={diffView}
                />
              ) : (
                <p className="p-4 text-xs text-muted-foreground">
                  Nothing to show for this file.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const totalCount = files.length;
  const canCommit =
    commitMessage.trim() !== "" && totalCount > 0 && busy === null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-sm text-foreground">
      {showRepoPicker ? (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <Icon
            name="FolderGit"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <select
            aria-label="Repository"
            value={selectedRepo}
            disabled={busy !== null}
            onChange={(event) => void switchRepo(event.target.value)}
            className="h-7 min-w-0 flex-1 truncate rounded-md border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            {!rootIsRepo && selectedRepo === "" ? (
              <option value="" disabled>
                Select a repository…
              </option>
            ) : null}
            {repos.map((repo) => (
              <option key={repo.relPath} value={repo.relPath}>
                {repoLabel(repo)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="GitBranch" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">
          {status?.branch ?? (status?.detached ? "detached HEAD" : "—")}
        </span>
        {status && status.ahead > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            ↑{status.ahead}
          </span>
        ) : null}
        {status && status.behind > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            ↓{status.behind}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Refresh"
            disabled={busy !== null}
            onClick={refresh}
          >
            <Icon name="ArrowReloadHorizontal" className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2"
            disabled={busy !== null || !status?.isGitRepo}
            onClick={() => setBranchOpen(true)}
          >
            <Icon name="GitBranch" className="size-4" />
            Branch
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2"
            disabled={busy !== null || !status?.hasRemote}
            onClick={push}
          >
            <Icon name="ArrowUp" className="size-4" />
            {busy === "push" ? "Pushing…" : "Push"}
          </Button>
        </div>
      </div>

      {status?.isGitRepo && data?.workspacePath !== null ? (
        <div className="border-b border-border p-3">
          <textarea
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void commit();
              }
            }}
            rows={2}
            placeholder="Commit message (⌘/Ctrl+Enter)"
            className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 gap-1.5"
              disabled={!canCommit}
              onClick={() => void commit()}
            >
              <Icon name="Check" className="size-4" />
              {busy === "commit"
                ? "Committing…"
                : stagedFiles.length > 0
                  ? "Commit"
                  : "Commit All"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {stagedFiles.length > 0
                ? `${stagedFiles.length} staged`
                : `${totalCount} change${totalCount === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={cn(
            "flex items-start gap-2 border-b border-border px-3 py-2 text-xs",
            notice.kind === "error"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {notice.text}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
            className="shrink-0 hover:text-foreground"
          >
            ✕
          </button>
        </div>
      ) : null}

      {body}

      <Dialog open={branchOpen} onOpenChange={setBranchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create branch</DialogTitle>
            <DialogDescription>
              Branches from the current HEAD and switches to it.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitBranch();
              }
            }}
            placeholder="feature/my-change"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBranchOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={branchName.trim() === "" || busy !== null}
              onClick={() => void submitBranch()}
            >
              Create &amp; switch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDiscard !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDiscard(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              {pendingDiscard?.length === 1
                ? `Discard all changes to ${pendingDiscard[0]}. This cannot be undone.`
                : `Discard changes to ${pendingDiscard?.length ?? 0} files. This cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDiscard(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDiscard()}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Centered({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <p
        className={cn(
          "max-w-sm text-center text-sm",
          tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {children}
      </p>
    </div>
  );
}

function ChangesHeaderButton({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { data } = useChanges(threadId);
  const nav = useBbNavigate();
  const status = data?.status;
  const repoCount = data?.repos.length ?? 0;
  // Show once we know there's something to manage: an active repo, or nested
  // repos waiting to be picked.
  if (!data || (!data.rootIsRepo && repoCount === 0)) return null;
  const active = status?.isGitRepo ?? false;
  const count = status?.files.length ?? 0;
  const badge = active ? String(count) : `${repoCount} repos`;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2"
      aria-label={
        active
          ? `Changes: ${count} file${count === 1 ? "" : "s"}`
          : `Changes: choose from ${repoCount} repositories`
      }
      onClick={() =>
        nav.openThreadPanel({ actionId: "porcelain", title: "Changes" })
      }
    >
      <Icon name="GitBranch" className="size-4" />
      {isCompactViewport ? null : (
        <span className="text-xs tabular-nums">{badge}</span>
      )}
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "porcelain",
    title: "Changes",
    icon: "GitBranch",
    layout: "flush",
    component: ChangesPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "porcelain-header",
    title: "Changes",
    component: ChangesHeaderButton,
  });
});
