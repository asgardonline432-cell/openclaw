export const SANDBOX_MISSING_MUTATION_PYTHON_GUIDANCE =
  "Sandbox filesystem helpers require python3 (or python) inside the sandbox runtime. Rebuild the default sandbox image with `scripts/sandbox-setup.sh`, or install python3 in the configured sandbox image before retrying. This guidance covers stale or misbuilt sandbox images and does not change Docker image fallback behavior.";

const PINNED_MUTATION_HELPER_MISSING_PYTHON =
  "sandbox pinned mutation helper requires python3 or python";

const MISSING_PYTHON_PATTERNS = [
  PINNED_MUTATION_HELPER_MISSING_PYTHON,
  "python3: not found",
  "python3: command not found",
  "python: not found",
  "python: command not found",
];

export function wrapSandboxMutationPythonError(error: unknown): unknown {
  if (!isSandboxMutationPythonMissingError(error)) {
    return error;
  }

  return Object.assign(new Error(SANDBOX_MISSING_MUTATION_PYTHON_GUIDANCE), {
    code: "INVALID_CONFIG",
    cause: error,
  });
}

function isSandboxMutationPythonMissingError(error: unknown): boolean {
  const text = collectDiagnosticText(error).toLowerCase();
  return MISSING_PYTHON_PATTERNS.some((pattern) => text.includes(pattern));
}

function collectDiagnosticText(error: unknown): string {
  if (error instanceof Error) {
    return [error.message, stringifyDiagnosticField(getDiagnosticField(error, "stderr"))]
      .filter(Boolean)
      .join("\n");
  }
  return stringifyDiagnosticField(error);
}

function getDiagnosticField(error: Error, key: string): unknown {
  return key in error ? (error as unknown as Record<string, unknown>)[key] : undefined;
}

function stringifyDiagnosticField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}
