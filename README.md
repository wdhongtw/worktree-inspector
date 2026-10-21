# Git Worktree Inspector (`worktree-inspector`)

Interactive UI plugin and MCP toolset (`worktree_*`) for tracking active Git worktrees and viewing live diffs in the Auxiliary Pane.

## Architecture: Per-Chat Session Trajectory Metadata
- **Zero Filesystem Marker State**: Does not write marker files to `.git/`, `<brain-dir>`, or scan arbitrary workspace directories.
- **Explicit Agent Reporting (`worktree_*` MCP Tools)**:
  - `worktree_register`: Register and optionally focus a Git worktree for the current conversation (`path`, `base_ref`, `label`, `focus`).
  - `worktree_focus`: Switch the active/focused worktree in the UI panel.
  - `worktree_unregister`: Remove a worktree from the session's tracked list.
  - `worktree_list`: List worktrees tracked in the current session trajectory.
- **Client-Side Session Fork Inheritance**: Worktree metadata is stored directly as `CORTEX_STEP_TYPE_MCP_TOOL` steps inside the conversation's `CortexTrajectory` (queried via `LanguageServerService/GetCascadeTrajectory` and `GetCascadeTrajectorySteps`). When a conversation is forked in the client (`ForkCascade` / `BranchCascade`), the trajectory steps up to the fork point are cloned into the new session, so forked sessions automatically inherit the exact worktree state at the point of the fork while keeping subsequent registrations isolated.
- **Flexible Diff Modes**:
  - **All vs Base**: Full diff against the branch's merge-base (committed + dirty changes).
  - **Dirty**: Working tree changes (staged + unstaged + untracked files).
  - **Commits**: Committed changes (`merge-base..HEAD`) with clickable per-commit diff filter.
  - **Staged**: Index (`git diff --cached`) changes.
