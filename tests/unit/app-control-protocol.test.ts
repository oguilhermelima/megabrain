import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { AppControlBroker, type AppControlSocket } from "../../src/chat/app-control.js";

class FakeSocket extends EventEmitter implements AppControlSocket {
  writes: string[] = [];
  destroyed = false;
  write(data: string) { this.writes.push(data); return true; }
  end() { this.destroyed = true; }
}

const brokers: AppControlBroker[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.close(); });

describe("chatd app control relay", () => {
  test("sends a correlated request to the connected app and returns its reply", async () => {
    const broker = new AppControlBroker(100);
    brokers.push(broker);
    const socket = new FakeSocket();
    broker.connect(socket);
    const pending = broker.request({ action: "layout" });
    const sent = JSON.parse(socket.writes[0]!) as { id: string; request: unknown };
    expect(sent.request).toEqual({ action: "layout" });
    broker.reply(socket, { id: sent.id, value: { panes: [] } });
    await expect(pending).resolves.toEqual({ panes: [] });
  });

  test("reports that no desktop app is connected", async () => {
    const broker = new AppControlBroker(100);
    brokers.push(broker);
    await expect(broker.request({ action: "layout" })).rejects.toThrow(/no desktop app is connected/i);
  });

  test("times out when the connected app does not answer", async () => {
    const broker = new AppControlBroker(10);
    brokers.push(broker);
    broker.connect(new FakeSocket());
    await expect(broker.request({ action: "layout" })).rejects.toThrow(/desktop app did not answer/i);
  });
});
