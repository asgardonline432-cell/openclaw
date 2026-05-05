# Mantis Slack Desktop Smoke

Status: pass
Slack URL: https://app.slack.com/client/T0B0KAN986T/C0B1R332Z2Q
Output: /home/runner/work/openclaw/openclaw/.artifacts/qa-e2e/mantis/slack-desktop-smoke-worktrees/candidate/.artifacts/qa-e2e/mantis/slack-desktop-smoke
Started: 2026-05-05T20:14:17.731Z
Finished: 2026-05-05T20:17:53.478Z

## Crabbox

- Provider: aws
- Lease: cbx_f577c8d30431 (crimson-prawn)
- Created by run: true
- State: active
- VNC: `crabbox vnc --provider aws --id cbx_f577c8d30431 --open`
- Hydrate mode: source

## Timings

- Total: 215.7s
- crabbox.warmup: 93.6s (pass)
- crabbox.inspect: 0.5s (pass)
- credentials.prepare: 0.7s (pass)
- crabbox.remote_run: 116.6s (fail)
- artifacts.copy: 4.3s (pass)

## Artifacts

- Screenshot: `slack-desktop-smoke.png`
- Video: `slack-desktop-smoke.mp4`
- Slack QA artifacts: `slack-qa/`
- Remote metadata: `remote-metadata.json`
- Remote command log: `slack-desktop-command.log`
- FFmpeg log: `ffmpeg.log`
- Chrome log: `chrome.log`

