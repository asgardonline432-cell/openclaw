# Mantis Telegram Desktop Proof Blocked

Native Telegram Desktop GIF proof could not be captured in this sandbox.

- PR inspection via `gh pr view` and `gh pr diff` was attempted but GitHub API access failed with network/DNS errors.
- Baseline and candidate detached checkouts were created under `.artifacts/qa-e2e/mantis/telegram-desktop-proof-worktrees/`.
- `pnpm install` and `pnpm build` completed for both refs using Node 24 and a writable copy of the preloaded pnpm store.
- Real `pnpm qa:telegram-user:crabbox -- start` was attempted for both refs.
- Both starts failed before session creation while resolving the Convex credential broker host (`EAI_AGAIN`).
- No Telegram credential lease, Crabbox lease, Telegram Desktop session, GIF, MP4, screenshot, or raw session archive was created.

No visual proof artifact is included because fabricating a GIF would violate the Mantis proof requirements.