import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const [stateDir, dispatchId, pidText] = process.argv.slice(2);
if (!stateDir || !dispatchId || !pidText || !/^\d+$/.test(pidText)) {
  throw new Error("usage: write-waiter.mjs <state-dir> <dispatch-id> <pid>");
}
const database = new DatabaseSync(resolve(stateDir, "megabrain.db"));
try {
  database.prepare("INSERT INTO waiters (dispatch_id, pid, parent_session_id, parent_host, created_at) VALUES (?, ?, ?, ?, ?)").run(
    dispatchId,
    Number(pidText),
    "parent-terminal",
    "superset",
    new Date().toISOString(),
  );
} finally {
  database.close();
}
