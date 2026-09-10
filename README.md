# bb-plugin-porcelain

**Porcelain** — a VS Code-style Source Control surface for a BB thread's
environment. (Named after `git status --porcelain`, git's term for its
user-facing layer, which is exactly what this plugin parses.)

Every thread runs in an environment with a working directory. This plugin
gives that working tree the same review-and-commit workflow you get from the
VS Code SCM view, without leaving BB.

## Surfaces

- **"Changes" tab** in the thread's right panel (`+` → Changes). Flush-layout
  panel that owns its UI:
  - **repository picker** — if the environment root is a git repo it's used
    directly; if not, the panel scans up to 3 levels down for nested repos
    (a "projects folder" layout) and lets you choose which one to manage. The
    choice sticks per thread. A lone nested repo is selected automatically.
  - current branch, ahead/behind counts
  - **Staged Changes** and **Changes** groups, each file with a status letter
    (`M`/`A`/`D`/`R`/`C`/`T`/`U`/`!`)
  - **list / tree toggle** (toolbar) — flat paths, or a collapsible folder
    tree with single-child chains compacted; folder rows stage / unstage /
    discard everything under them. Preference persists.
  - per-file **Stage** / **Unstage** / **Discard**, plus **Stage All** /
    **Unstage All** on each group
  - click a file to see its unified/split diff (BB's `experimental_Diff`
    viewer, with syntax highlighting and the live code theme)
  - commit message box → **Commit** (commits the index) or **Commit All**
    (stages everything first); ⌘/Ctrl+Enter commits
  - **Branch** — a dialog with a **Switch to** dropdown listing every local
    branch (current one selected) and every remote-only branch (checking one
    out creates a local tracking branch), plus a field to create a new branch
    from HEAD and switch to it
  - icon controls carry hover/focus **tooltips**
  - **Push** — `git push`, with `--set-upstream` when the branch has no
    upstream yet
- **Thread-header button** — a compact branch glyph + change count that opens
  the Changes tab.

The panel stays live: it refetches on the `porcelain:<threadId>` realtime
signal (emitted after every mutation and around agent turns) and on window
focus.

## Architecture

| File          | Role                                                                                   |
| ------------- | ------------------------------------------------------------------------------------- |
| `contract.ts` | Shared host RPC contract + zod schemas (`status`, `diff`, `stage`, `commit`, …).       |
| `host.ts`     | Full-trust Node worker. Shells out to `git` in the resolved worktree. No shell, bounded output, 20s timeout per call. |
| `server.ts`   | Loopback RPC for the frontend. Resolves `threadId` → environment → `{ path, hostId }`, forwards to the host, publishes the refresh signal. |
| `app.tsx`     | The panel + header button. Pure view over the RPC.                                    |

Git operations run on the environment's own host, so this works for threads
on enrolled remote machines too.

## Scope notes

- Operates on the **git working tree** only.
- File-level staging in the UI. Hunk-level RPCs (`stageHunk`, `unstageHunk`,
  `revertHunk`) exist on the contract for a future hunk UI / agent use.
- `Discard` reverts a file to `HEAD` (staged **and** unstaged) and deletes
  untracked files — it asks for confirmation first.

## Develop

```
bb plugin install .      # register this directory
bb plugin dev            # rebuild + reload on save
bb plugin logs porcelain -f
```
