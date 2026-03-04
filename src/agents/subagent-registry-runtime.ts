export {
  countActiveDescendantRuns,
  countPendingDescendantRuns,
  countPendingDescendantRunsExcludingRun,
  isSubagentSessionRunActive,
  listSubagentRunsForRequester,
  resolveRequesterForChildSession,
  shouldIgnorePostCompletionAnnounceForSession,
} from "./subagent-registry.js";
