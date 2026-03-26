import { describe, expect, it } from "vitest";
import {
  resolveExecutionBudget,
  resolveRuntimeCapabilities,
  resolveThreadPoolPolicy,
} from "../../scripts/test-planner/runtime-profile.mjs";

describe("thread pool policy", () => {
  it("keeps constrained local hosts on forks", () => {
    const runtime = resolveRuntimeCapabilities(
      {},
      {
        mode: "local",
        platform: "darwin",
        cpuCount: 8,
        totalMemoryBytes: 32 * 1024 ** 3,
        loadAverage: [1.6, 1.6, 1.6],
      },
    );

    expect(resolveThreadPoolPolicy(runtime, {})).toMatchObject({
      threadExpansionEnabled: false,
      defaultUnitPool: "forks",
      defaultBasePool: "forks",
      unitFastLaneCount: 1,
      reason: "memory-below-thread-threshold",
    });
  });

  it("enables threads for strong idle local hosts", () => {
    const runtime = resolveRuntimeCapabilities(
      {},
      {
        mode: "local",
        platform: "darwin",
        cpuCount: 16,
        totalMemoryBytes: 128 * 1024 ** 3,
        loadAverage: [2, 2, 2],
      },
    );

    expect(resolveThreadPoolPolicy(runtime, {})).toMatchObject({
      threadExpansionEnabled: true,
      defaultUnitPool: "threads",
      defaultBasePool: "threads",
      unitFastLaneCount: 2,
      reason: "strong-local-host",
    });
  });

  it("disables thread expansion for saturated local hosts", () => {
    const runtime = resolveRuntimeCapabilities(
      {},
      {
        mode: "local",
        platform: "darwin",
        cpuCount: 16,
        totalMemoryBytes: 128 * 1024 ** 3,
        loadAverage: [17, 17, 17],
      },
    );

    expect(resolveThreadPoolPolicy(runtime, {})).toMatchObject({
      threadExpansionEnabled: false,
      defaultUnitPool: "forks",
      defaultBasePool: "forks",
      unitFastLaneCount: 1,
      reason: "host-under-load",
    });
  });

  it("honors explicit force-threads overrides", () => {
    const runtime = resolveRuntimeCapabilities(
      { OPENCLAW_TEST_FORCE_THREADS: "1" },
      {
        mode: "local",
        platform: "darwin",
        cpuCount: 8,
        totalMemoryBytes: 32 * 1024 ** 3,
        loadAverage: [8, 8, 8],
      },
    );

    expect(resolveExecutionBudget(runtime)).toMatchObject({
      threadExpansionEnabled: true,
      defaultUnitPool: "threads",
      defaultBasePool: "threads",
      threadPoolReason: "forced-threads",
    });
  });

  it("keeps CI on the current unit/base policy", () => {
    const runtime = resolveRuntimeCapabilities(
      { CI: "true", GITHUB_ACTIONS: "true" },
      {
        mode: "ci",
        platform: "linux",
        cpuCount: 32,
        totalMemoryBytes: 128 * 1024 ** 3,
      },
    );

    expect(resolveExecutionBudget(runtime)).toMatchObject({
      threadExpansionEnabled: false,
      defaultUnitPool: "forks",
      defaultBasePool: "forks",
      unitFastLaneCount: 3,
      threadPoolReason: "ci-preserves-current-policy",
    });
  });
});
