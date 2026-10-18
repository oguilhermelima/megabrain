import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDelivery, createDispatch, listDeliveries, stateDatabase } from "../../src/adapters/state-db.js";
import { acknowledgeImplicitDelivery } from "../../src/adapters/state-db.js";

describe("implicit delivery acknowledgements", () => {
  test.each(["child", "parent"] as const)("settles a %s delivery after its consumer proves it was read", async (recipient) => {
    const root = await mkdtemp(`${tmpdir()}/implicit-ack-`);
    try {
      const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
      if (database.kind !== "ok") throw new Error(database.error);
      createDispatch(database.value, { dispatchId: "d-implicit", state: "running" });
      createDelivery(database.value, { id: `delivery-${recipient}`, dispatchId: "d-implicit", recipient, messageSeqs: [1], status: "outstanding" });

      const settled = acknowledgeImplicitDelivery(database.value, "d-implicit", `delivery-${recipient}`, recipient);

      expect(settled).toMatchObject({ kind: "ok", value: true });
      expect(listDeliveries(database.value, "d-implicit")).toMatchObject({ kind: "ok", value: [{ id: `delivery-${recipient}`, status: "acknowledged" }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not settle a delivery when the observed consumer direction does not match", async () => {
    const root = await mkdtemp(`${tmpdir()}/implicit-ack-`);
    try {
      const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
      if (database.kind !== "ok") throw new Error(database.error);
      createDispatch(database.value, { dispatchId: "d-implicit", state: "running" });
      createDelivery(database.value, { id: "delivery-parent", dispatchId: "d-implicit", recipient: "parent", messageSeqs: [1], status: "outstanding" });

      const settled = acknowledgeImplicitDelivery(database.value, "d-implicit", "delivery-parent", "child");

      expect(settled).toMatchObject({ kind: "ok", value: false });
      expect(listDeliveries(database.value, "d-implicit")).toMatchObject({ kind: "ok", value: [{ id: "delivery-parent", status: "outstanding" }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
