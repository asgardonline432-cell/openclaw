# Mantis Telegram Desktop Proof Blocked

Native Telegram Desktop proof was not captured.

Attempted scenario:
- Register the same proof-only `mantisdirect` plugin command in both detached worktrees.
- Send `/mantisdirect <marker>` from the real Telegram user.
- Baseline expectation: direct Telegram Bot API response followed by `No response generated. Please try again.`
- Candidate expectation: direct Telegram Bot API response only.

Blockers observed:
- AWS Crabbox desktop provisioning failed before session creation because AWS returned `RulesPerSecurityGroupLimitExceeded` for security-group ingress.
- Retrying on the supported Hetzner provider reached the Telegram credential broker, but the shared `telegram-user` pool returned `POOL_EXHAUSTED` twice.

Cleanup:
- No `session.json` existed for baseline or candidate after the failed starts.
- Crabbox list checks for AWS and Hetzner showed no user-visible lease to finish.
