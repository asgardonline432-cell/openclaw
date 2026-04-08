# Kova

Kova is how OpenClaw proves it works.

Kova replaces scattered scripts, isolated reports, and disconnected validation lanes with one serious system for running checks, inspecting outcomes, comparing baselines, and tracking regressions.

## Why Kova Matters

Kova exists to make OpenClaw quality visible and trustworthy.

- one place to run the checks that matter
- one run record that works across targets and backends
- one way to inspect results, compare baselines, and track regressions
- one path to bring QA, VM validation, and platform checks together without creating more sprawl

OpenClaw already has meaningful verification work. Kova turns that work into a real platform.

## How Kova Works

Kova is built around four commands:

- `run`: execute a verification workload and record the result
- `report`: inspect one recorded run
- `diff`: compare a candidate run against a baseline or prior comparable run
- `list`: browse targets, backends, scenarios, capabilities, and recorded history

The flow is simple:

1. `kova run ...`
2. Kova writes a run artifact under `.artifacts/kova/runs/`
3. `kova report`, `kova diff`, and `kova list` operate on those same artifacts

## Quick Start

```bash
pnpm kova --help
pnpm kova run --help
pnpm kova list targets
pnpm kova list runs
pnpm kova report latest
```

If you only want one command to get started, use this:

```bash
pnpm kova run qa --scenario channel-chat-baseline
```

That gives you a real Kova run immediately, writes the result under `.artifacts/kova/runs/`, and gives you something real to inspect with `report` and `diff`.

If the QA host lane blocks on a clean checkout because `dist/index.js` is missing, run
`pnpm build` once, then rerun the same Kova command.

## Common Workflows

Run a single QA scenario on the default host backend:

```bash
pnpm kova run qa --scenario channel-chat-baseline
```

On a clean checkout, run `pnpm build` first if Kova tells you the QA gateway build
output is missing.

Run QA inside Multipass:

```bash
pnpm kova run qa --backend multipass
```

If Multipass is not installed, Kova records a blocked run and prints install
guidance instead of failing with an opaque error.

Run judged character evaluation across live models:

```bash
pnpm kova run character-eval \
  --model openai/gpt-5.4 \
  --judge-model openai/gpt-5.4 \
  --scenario character-vibes-gollum
```

Run Parallels guest smoke:

```bash
pnpm kova run parallels --guest macos --mode fresh
```

Inspect the latest run for one lane:

```bash
pnpm kova report latest --target character-eval
pnpm kova report latest --target parallels --guest macos
```

Compare recent comparable runs:

```bash
pnpm kova diff
pnpm kova diff --target qa --backend host
pnpm kova diff --target character-eval
```

Browse recorded history and catalog data:

```bash
pnpm kova list runs
pnpm kova list runs --target parallels --guest macos
pnpm kova list scenarios qa
pnpm kova list capabilities
```

## What Kova Covers

Kova currently exposes these first-class targets:

- `qa`
  - behavioral scenario verification
  - default backend: `host`
  - optional backend: `multipass`
- `character-eval`
  - judged vibe/persona evaluation across candidate models
  - backend: `host`
- `parallels`
  - guest OS smoke validation
  - backend: `parallels`

## Every Run Becomes Evidence

Every Kova run writes a run bundle under:

```text
.artifacts/kova/runs/<run-id>/
```

That bundle is what makes Kova more than a runner. It is the evidence Kova keeps for:

- run status and verdict
- scenario and capability coverage
- backend and environment metadata
- evidence paths such as reports and summaries
- history and diff comparisons

## Help Surface

Kova help is command-owned. Start small, then go deeper:

```bash
pnpm kova --help
pnpm kova run --help
pnpm kova report --help
pnpm kova diff --help
pnpm kova list --help
pnpm kova list runs --help
```

## Current Scope

- QA is the first major Kova lane.
- QA uses the `host` backend by default unless `--backend` is provided.
- Multipass is the first VM-backed QA backend.
- Character eval is available as a judged host-side target for vibe and persona comparisons.
- Parallels is available as a guest-smoke target over the existing smoke scripts.

Kova sets the standard for how OpenClaw gets tested and verified: one system, one history, and one clear answer when it is time to prove that OpenClaw works.
