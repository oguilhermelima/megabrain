import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDispatchArchived, getDispatch, listDeliveries, listMessages } from "../../src/adapters/state-db.js";
import { openDatabase, withWrite } from "../../src/db/db.js";
import { applyJsonStateImport, parseJsonState } from "../../src/db/import/json-state.js";

export async function importDispatchFixture(stateDir: string, dispatchId: string): Promise<void> {
  const source = await mkdtemp(join(tmpdir(), "megabrain-unit-fixture-"));
  try {
    await mkdir(join(source, "dispatches"), { recursive: true });
    await cp(join(stateDir, "dispatches", dispatchId), join(source, "dispatches", dispatchId), { recursive: true });
    await importStateFixture(stateDir, source, true);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

export async function importStateFixture(stateDir: string, sourceDir = stateDir, replace = true): Promise<void> {
  const parsed = await parseJsonState(sourceDir);
  const opened = openDatabase({ MEGABRAIN_STATE_DIR: stateDir });
  if (opened.kind !== "ok") throw new Error(opened.error);
  try {
    const imported = withWrite(opened.value, (db) => applyJsonStateImport(db, parsed, replace));
    if (imported.kind !== "ok") throw new Error(imported.error);
    if (imported.value.malformed.length > 0 || imported.value.conflicts.length > 0) {
      throw new Error(`fixture import failed: ${JSON.stringify(imported.value)}`);
    }
  } finally {
    opened.value.close();
  }
}

export function readDispatchFixture(stateDir: string, dispatchId: string) {
  const opened = openDatabase({ MEGABRAIN_STATE_DIR: stateDir });
  if (opened.kind !== "ok") throw new Error(opened.error);
  try {
    const meta = getDispatch(opened.value, dispatchId);
    if (meta.kind !== "ok") throw new Error(meta.error);
    if (meta.value === undefined) throw new Error(`dispatch not found: ${dispatchId}`);
    const messages = listMessages(opened.value, dispatchId);
    if (messages.kind !== "ok") throw new Error(messages.error);
    const deliveries = listDeliveries(opened.value, dispatchId);
    if (deliveries.kind !== "ok") throw new Error(deliveries.error);
    const archived = isDispatchArchived(opened.value, dispatchId);
    if (archived.kind !== "ok") throw new Error(archived.error);
    return { meta: meta.value, messages: messages.value, deliveries: deliveries.value, archived: archived.value };
  } finally {
    opened.value.close();
  }
}
