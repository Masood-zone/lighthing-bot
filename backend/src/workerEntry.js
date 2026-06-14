// Entry point for forked worker sessions.
// This isolates booking automation from the API server process.

const executionMode = String(
  process.env.VISA_EXECUTION_MODE || process.env.VISA_WORKER_MODE || "dom",
)
  .trim()
  .toLowerCase();

if (executionMode === "api") {
  require("../main/api-worker");
} else if (executionMode === "selenium") {
  require("../main/visa-bot");
} else {
  require("../main/index");
}
