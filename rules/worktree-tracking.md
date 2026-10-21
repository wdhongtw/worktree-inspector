# Git Worktree Session Tracking (`worktree_*`)

When working with Git worktrees in a conversation, keep the current chat session's worktree metadata synchronized using the `worktree_*` MCP tools:

- **Creating or starting work in a worktree**: Call `worktree_register` with `path`, optional `base_ref` (e.g. `origin/main` or the target release branch), and a concise `label` describing the task.
- **Switching focus between existing worktrees**: Call `worktree_focus` with `path`.
- **Removing or finishing a worktree**: Call `worktree_unregister` with `path` when the worktree is no longer active for this conversation.
- **Inspecting tracked session worktrees**: Call `worktree_list` to check which worktrees are registered in the current conversation (including any inherited from a forked parent conversation).
