/**
 * E2E client: local-external-cron-scheduler extension
 *
 * Tests the cron_changed hook and the local-external-cron-scheduler extension
 * by exercising all cron job lifecycle events (add, disable, enable, remove,
 * finished) and verifying the JSON state file is correctly updated.
 *
 * Expects:
 *   GW_URL   — gateway WebSocket URL  (e.g. ws://127.0.0.1:18789)
 *   GW_TOKEN — gateway auth token
 *   OPENCLAW_STATE_DIR — state directory (default: ~/.openclaw)
 *   CRON_INTERVAL_MS   — recurring interval for the fire test (default: 10000)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assert, connectGateway, type GatewayRpcClient, waitFor } from "./mcp-channels-harness.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

interface SchedulerState {
  version: number;
  updatedAtMs: number;
  jobs: SchedulerJob[];
}

interface SchedulerJob {
  instanceId: string;
  jobId: string;
  name: string;
  wakeAtMs: number;
  nextRunAtMs: number;
  command: string;
  enabled: boolean;
  schedule: { kind: string; everyMs?: number };
  sessionTarget: string;
  wakeMode: string;
  updatedAtMs: number;
}

interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function readState(statePath: string): Promise<SchedulerState> {
  const raw = await fs.readFile(statePath, "utf-8");
  return JSON.parse(raw) as SchedulerState;
}

async function waitForStateFile(statePath: string, timeoutMs = 30_000): Promise<SchedulerState> {
  return waitFor(
    "state file exists",
    async () => {
      try {
        return await readState(statePath);
      } catch {
        return undefined;
      }
    },
    timeoutMs,
  );
}

async function waitForJobCount(
  statePath: string,
  expected: number,
  timeoutMs = 15_000,
): Promise<SchedulerState> {
  return waitFor(
    `state file has ${expected} job(s)`,
    async () => {
      try {
        const state = await readState(statePath);
        return state.jobs.length === expected ? state : undefined;
      } catch {
        return undefined;
      }
    },
    timeoutMs,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

async function testGatewayStartWritesState(statePath: string): Promise<void> {
  console.log("Test 1: gateway_start writes initial state file");
  const state = await waitForStateFile(statePath);
  assert(state.version === 1, `expected version=1, got ${state.version}`);
  assert(state.jobs.length === 0, `expected 0 jobs on startup, got ${state.jobs.length}`);
  console.log("  ✓ State file created with version=1, 0 jobs");
}

async function testAddJob(
  gateway: GatewayRpcClient,
  statePath: string,
  intervalMs: number,
): Promise<string> {
  console.log("Test 2: cron add → job appears in state file");
  const job = await gateway.request<CronJob>("cron.add", {
    name: "e2e-ext-cron-add",
    enabled: true,
    schedule: { kind: "every", everyMs: intervalMs },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Say OK", timeoutSeconds: 30 },
    delivery: { mode: "none" },
  });
  assert(job.id, `cron.add did not return an id: ${JSON.stringify(job)}`);
  console.log(`  Created job: ${job.id}`);

  const state = await waitForJobCount(statePath, 1);
  const stateJob = state.jobs[0]!;

  assert(stateJob.jobId === job.id, `jobId mismatch: ${stateJob.jobId} !== ${job.id}`);
  console.log("  ✓ Job ID matches");

  assert(stateJob.enabled === true, `expected enabled=true, got ${stateJob.enabled}`);
  console.log("  ✓ Job enabled=true");

  const expectedCmd = `openclaw cron run ${job.id} --due`;
  assert(
    stateJob.command === expectedCmd,
    `command mismatch: ${stateJob.command} !== ${expectedCmd}`,
  );
  console.log(`  ✓ Command field correct`);

  assert(stateJob.wakeAtMs > 0, `wakeAtMs should be positive, got ${stateJob.wakeAtMs}`);
  console.log(`  ✓ wakeAtMs set (${stateJob.wakeAtMs})`);

  assert(
    stateJob.schedule.kind === "every" && stateJob.schedule.everyMs === intervalMs,
    `schedule mismatch: ${JSON.stringify(stateJob.schedule)}`,
  );
  console.log(`  ✓ Schedule preserved (every ${intervalMs}ms)`);

  return job.id;
}

async function testAddSecondJob(gateway: GatewayRpcClient, statePath: string): Promise<string> {
  console.log("Test 3: second cron add → two jobs in state");
  const job = await gateway.request<CronJob>("cron.add", {
    name: "e2e-ext-cron-add-2",
    enabled: true,
    schedule: { kind: "every", everyMs: 300_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Say OK 2", timeoutSeconds: 30 },
    delivery: { mode: "none" },
  });
  assert(job.id, "cron.add did not return an id");
  console.log(`  Created job: ${job.id}`);

  const state = await waitForJobCount(statePath, 2);
  assert(state.jobs.length === 2, `expected 2 jobs, got ${state.jobs.length}`);
  console.log("  ✓ State file has 2 jobs");

  return job.id;
}

async function testDisableJob(
  gateway: GatewayRpcClient,
  statePath: string,
  jobId: string,
  remainingJobId: string,
): Promise<void> {
  console.log("Test 4: cron disable → job removed from state (includeDisabled=false)");
  await gateway.request("cron.update", { jobId, patch: { enabled: false } });

  const state = await waitForJobCount(statePath, 1);
  assert(state.jobs.length === 1, `expected 1 job after disable, got ${state.jobs.length}`);
  console.log("  ✓ Disabled job removed from state");

  assert(
    state.jobs[0]!.jobId === remainingJobId,
    `wrong job remaining: ${state.jobs[0]!.jobId} (expected ${remainingJobId})`,
  );
  console.log(`  ✓ Remaining job is correct (${remainingJobId})`);
}

async function testEnableJob(
  gateway: GatewayRpcClient,
  statePath: string,
  jobId: string,
): Promise<void> {
  console.log("Test 5: cron enable → job reappears in state");
  await gateway.request("cron.update", { jobId, patch: { enabled: true } });

  const state = await waitForJobCount(statePath, 2);
  assert(state.jobs.length === 2, `expected 2 jobs after re-enable, got ${state.jobs.length}`);
  console.log("  ✓ Re-enabled job reappears (2 jobs)");
}

async function testRemoveJob(
  gateway: GatewayRpcClient,
  statePath: string,
  jobId: string,
): Promise<void> {
  console.log("Test 6: cron rm → job removed from state");
  await gateway.request("cron.remove", { jobId });

  const state = await waitForJobCount(statePath, 1);
  assert(state.jobs.length === 1, `expected 1 job after rm, got ${state.jobs.length}`);
  console.log("  ✓ Removed job gone from state");
}

async function testFinishedAdvancesWakeAt(
  gateway: GatewayRpcClient,
  statePath: string,
  jobId: string,
  intervalMs: number,
): Promise<void> {
  console.log(`Test 7: cron fires → wakeAtMs advances (forcing run, interval=${intervalMs}ms)`);

  const stateBefore = await readState(statePath);
  const jobBefore = stateBefore.jobs.find((j) => j.jobId === jobId);
  assert(jobBefore, `job ${jobId} not found in state before run`);
  const wakeBefore = jobBefore.wakeAtMs;
  console.log(`  wakeAtMs before: ${wakeBefore}`);

  // Force-run the cron job instead of waiting for the timer
  const run = await gateway.request<{ ok?: boolean; enqueued?: boolean }>("cron.run", {
    id: jobId,
    mode: "force",
  });
  assert(run.ok === true && run.enqueued === true, `cron.run not enqueued: ${JSON.stringify(run)}`);

  // Wait for the finished event
  const finished = await waitFor(
    "cron finished event",
    () =>
      gateway.events.find(
        (e) => e.event === "cron" && e.payload.jobId === jobId && e.payload.action === "finished",
      )?.payload,
    120_000,
  );
  assert(finished, "missing cron finished event");
  console.log(`  Cron run finished (status: ${finished.status})`);

  // Wait for state file to update with new wakeAtMs
  const stateAfter = await waitFor(
    "wakeAtMs advanced",
    async () => {
      const s = await readState(statePath);
      const j = s.jobs.find((j) => j.jobId === jobId);
      if (j && j.wakeAtMs !== wakeBefore) return s;
      return undefined;
    },
    15_000,
  );

  const jobAfter = stateAfter.jobs.find((j) => j.jobId === jobId);
  assert(jobAfter, `job ${jobId} not found in state after run`);
  const wakeAfter = jobAfter.wakeAtMs;
  console.log(`  wakeAtMs after:  ${wakeAfter}`);

  const advanceMs = wakeAfter - wakeBefore;
  assert(
    advanceMs >= intervalMs,
    `wakeAtMs advanced by ${advanceMs}ms, expected ≥ ${intervalMs}ms`,
  );
  console.log(`  ✓ wakeAtMs advanced by ${advanceMs}ms (≥ ${intervalMs}ms)`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const gatewayUrl = process.env.GW_URL?.trim();
  const gatewayToken = process.env.GW_TOKEN?.trim();
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() || path.join(process.env.HOME || "/tmp", ".openclaw");
  const statePath = path.join(stateDir, "external-cron-scheduler", "jobs.json");
  const intervalMs = Number(process.env.CRON_INTERVAL_MS || "10000");

  assert(gatewayUrl, "missing GW_URL");
  assert(gatewayToken, "missing GW_TOKEN");

  console.log(`State path: ${statePath}`);
  console.log(`Interval:   ${intervalMs}ms`);
  console.log("");

  const gateway = await connectGateway({ url: gatewayUrl, token: gatewayToken });
  let passCount = 0;
  let failCount = 0;

  try {
    // Test 1: gateway_start wrote the initial state
    await testGatewayStartWritesState(statePath);
    passCount++;

    // Test 2: add a job
    const job1Id = await testAddJob(gateway, statePath, intervalMs);
    passCount++;

    // Test 3: add a second job
    const job2Id = await testAddSecondJob(gateway, statePath);
    passCount++;

    // Test 4: disable second job
    await testDisableJob(gateway, statePath, job2Id, job1Id);
    passCount++;

    // Test 5: re-enable second job
    await testEnableJob(gateway, statePath, job2Id);
    passCount++;

    // Test 6: remove second job
    await testRemoveJob(gateway, statePath, job2Id);
    passCount++;

    // Test 7: force-run → wakeAtMs advances
    await testFinishedAdvancesWakeAt(gateway, statePath, job1Id, intervalMs);
    passCount++;

    // Cleanup: remove the remaining job
    await gateway.request("cron.remove", { jobId: job1Id });

    console.log("");
    console.log(`Results: ${passCount} passed, ${failCount} failed`);
    console.log("OK");
  } catch (error) {
    failCount++;
    console.error("");
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Results: ${passCount} passed, ${failCount} failed`);
    process.exit(1);
  } finally {
    await gateway.close();
  }
}

await main();
