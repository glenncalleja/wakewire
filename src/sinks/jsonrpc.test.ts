import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { assertLoopbackWsUrl } from "./codex-app-server.js";
import { JsonRpcWs } from "./jsonrpc.js";

const logger = pino({ level: "silent" });

describe("JsonRpcWs", () => {
  let server: WebSocketServer | null = null;
  let client: JsonRpcWs | null = null;

  afterEach(() => {
    client?.stop();
    server?.close();
  });

  async function startServer(
    onMessage: (msg: Record<string, unknown>, send: (m: unknown) => void) => void,
  ): Promise<string> {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws) => {
      ws.on("message", (data) => {
        onMessage(JSON.parse(data.toString()), (m) => ws.send(JSON.stringify(m)));
      });
    });
    await new Promise((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return `ws://127.0.0.1:${address.port}`;
  }

  it("round-trips requests and dispatches notifications", async () => {
    const url = await startServer((msg, send) => {
      if (msg.method === "initialize") {
        send({ id: msg.id, result: { userAgent: "test" } });
        send({ method: "turn/completed", params: { threadId: "t1" } });
      }
    });
    client = new JsonRpcWs(url, logger);
    client.start();
    await client.waitOpen();
    const seen: string[] = [];
    client.onNotification = (method) => seen.push(method);
    const result = await client.request<{ userAgent: string }>("initialize", {});
    expect(result.userAgent).toBe("test");
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(["turn/completed"]);
  });

  it("rejects pending requests and fires onClose when the socket drops", async () => {
    const url = await startServer(() => {
      // never reply; kill the connection instead
      setTimeout(() => {
        for (const c of server?.clients ?? []) c.terminate();
      }, 50);
    });
    client = new JsonRpcWs(url, logger);
    client.start();
    await client.waitOpen();
    let closed = false;
    client.onClose = () => {
      closed = true;
    };
    await expect(client.request("initialize", {}, 5_000)).rejects.toThrow(/closed|error/i);
    expect(closed).toBe(true);
    expect(client.alive).toBe(false);
  });

  it("declines server-initiated requests", async () => {
    let declineSeen: Record<string, unknown> | null = null;
    const url = await startServer((msg, send) => {
      if (msg.method === "initialize") {
        send({ id: 99, method: "execCommandApproval", params: {} }); // server → client request
        send({ id: msg.id, result: {} });
      } else if (msg.id === 99) {
        declineSeen = msg;
      }
    });
    client = new JsonRpcWs(url, logger);
    client.start();
    await client.waitOpen();
    await client.request("initialize", {});
    await new Promise((r) => setTimeout(r, 100));
    expect(declineSeen).not.toBeNull();
    expect(JSON.stringify(declineSeen)).toContain("does not handle interactive requests");
  });
});

describe("assertLoopbackWsUrl", () => {
  it("accepts loopback ws URLs with ports", () => {
    expect(() => assertLoopbackWsUrl("ws://127.0.0.1:4571")).not.toThrow();
    expect(() => assertLoopbackWsUrl("ws://localhost:9000")).not.toThrow();
  });

  it("rejects non-loopback, non-ws, and portless URLs", () => {
    expect(() => assertLoopbackWsUrl("ws://0.0.0.0:4571")).toThrow(/loopback/);
    expect(() => assertLoopbackWsUrl("ws://192.168.1.10:4571")).toThrow(/loopback/);
    expect(() => assertLoopbackWsUrl("wss://127.0.0.1:4571")).toThrow(/loopback/);
    expect(() => assertLoopbackWsUrl("http://127.0.0.1:4571")).toThrow(/loopback/);
    expect(() => assertLoopbackWsUrl("ws://127.0.0.1")).toThrow(/loopback/);
    expect(() => assertLoopbackWsUrl("not a url")).toThrow(/invalid/);
  });
});
