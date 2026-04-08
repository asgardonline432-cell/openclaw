---
summary: "Kova: OpenClaw's system for running tests, recording results, and comparing verification history"
read_when:
  - You want to run OpenClaw verification work through one command surface
  - You need recorded run history, reports, or baseline comparisons
  - You are deciding whether to use Kova or a lower-level QA command directly
title: "Kova"
---

# Kova

Kova is how OpenClaw gets tested and verified as one system.

Kova replaces disconnected scripts, isolated reports, and lane-specific command
surfaces with one serious workflow for:

- running verification work
- recording results
- inspecting what happened
- comparing baselines
- tracking regressions over time

If you want recorded verification history instead of one-off command output, use
Kova.

## What Kova does

Kova is built around four commands:

- `pnpm kova run`
- `pnpm kova report`
- `pnpm kova diff`
- `pnpm kova list`

These commands all operate on the same recorded Kova runs under
`.artifacts/kova/runs/`.

That gives OpenClaw one place to:

- run QA scenarios
- run judged character evals
- run VM-backed verification lanes
- inspect the latest result
- compare one run against another
- browse targets, backends, scenarios, surfaces, capabilities, and history

## When to use Kova

Use Kova when you want:

- a real recorded run, not just terminal output
- a report you can inspect later
- a diff against a previous or passing baseline
- one command surface across QA, character eval, and VM-backed lanes

Use the lower-level `pnpm openclaw qa ...` commands when you are working on the
QA implementation itself or debugging a QA-specific lane directly.

## Core commands

### Run

Execute a verification workload and record the result:

```bash
pnpm kova run qa --scenario channel-chat-baseline
```

### Report

Inspect one recorded run:

```bash
pnpm kova report latest
pnpm kova report latest --target character-eval
```

### Diff

Compare a candidate run against a baseline or prior comparable run:

```bash
pnpm kova diff
pnpm kova diff --target qa --backend host
```

### List

Browse Kova data:

```bash
pnpm kova list runs
pnpm kova list scenarios qa
pnpm kova list capabilities
```

## Current targets

Kova currently exposes these first-class targets:

### `qa`

Behavioral scenario verification for OpenClaw's QA lane.

- default backend: `host`
- optional backend: `multipass`

Example:

```bash
pnpm kova run qa --scenario channel-chat-baseline
```

If the host QA lane blocks on a clean checkout because `dist/index.js` is missing,
run `pnpm build`, then rerun the same Kova command.

### `character-eval`

Judged vibe and persona evaluation across candidate models.

- backend: `host`

Example:

```bash
pnpm kova run character-eval \
  --model openai/gpt-5.4 \
  --judge-model openai/gpt-5.4 \
  --scenario character-vibes-gollum
```

### `parallels`

Guest OS smoke validation over the Parallels-backed install and runtime lanes.

- backend: `parallels`

Example:

```bash
pnpm kova run parallels --guest macos --mode fresh
```

## How Kova thinks about coverage

Kova exposes three important kinds of coverage data:

- `scenarios`: executable proofs Kova can run
- `surfaces`: product contexts where behavior is exercised
- `capabilities`: product guarantees OpenClaw is trying to prove

Example:

- scenario: `thread-memory-isolation`
- surface: `memory`
- capability: `memory.core`

That is what makes Kova more than a runner. It records what was tested, where it
was exercised, and what guarantee the run was supposed to prove.

## Common workflows

Run one QA scenario on the default host backend:

```bash
pnpm kova run qa --scenario channel-chat-baseline
```

Run QA inside Multipass:

```bash
pnpm kova run qa --backend multipass
```

If Multipass is not installed, Kova records a blocked run and prints install
instructions so you can fix the host and rerun the same command.

Inspect the latest recorded run:

```bash
pnpm kova report latest
```

Compare the latest comparable runs:

```bash
pnpm kova diff
```

Browse run history:

```bash
pnpm kova list runs
```

## Help flow

Start here:

```bash
pnpm kova --help
```

Then go one level deeper:

```bash
pnpm kova run --help
pnpm kova report --help
pnpm kova diff --help
pnpm kova list --help
```

## Related docs

- [Testing](/help/testing)
- [QA E2E Automation](/concepts/qa-e2e-automation)
