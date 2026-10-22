import { EventEmitter } from "node:events";
import type { Socket } from "node:net";

import { expect, test, vi } from "vitest";

import { requestLinuxBackground, sessionBusPaths, type IPortalBus } from "./linuxBackgroundPortal";

const incoming = (type: string, value: unknown) => [[{ type, child: [] }], [value]];
interface IFixtureOptions {
  early?: boolean;
  code?: number;
  background?: boolean;
  autostart?: boolean;
  silent?: boolean;
  badHandle?: boolean;
  addMatchError?: boolean;
  missingResult?: boolean;
  duplicate?: boolean;
  wrongSenderFirst?: boolean;
}
function fixture(options: IFixtureOptions = {}) {
  const connection = new EventEmitter() as IPortalBus["connection"];
  const stream = new EventEmitter() as unknown as Socket;
  const end = vi.fn(() => {
    queueMicrotask(() => stream.emit("close"));
    return stream;
  });
  const destroy = vi.fn(() => stream);
  stream.end = end;
  stream.destroy = destroy;
  connection.stream = stream;
  let requestSeen!: () => void;
  const seen = new Promise<void>((resolve) => {
    requestSeen = resolve;
  });
  let matchBeforeRequest = false;
  const bus: IPortalBus = {
    name: ":1.123",
    connection,
    invoke: vi.fn<IPortalBus["invoke"]>((message, callback) => {
      if (message.member === "GetId") return callback(undefined, "inert-bus-id");
      if (message.member === "Get") return callback(undefined, incoming("u", 2));
      if (message.member === "GetNameOwner") return callback(undefined, ":1.42");
      if (message.member === "AddMatch") {
        matchBeforeRequest = connection.listenerCount("message") === 1;
        return callback(
          options.addMatchError
            ? { name: "Test.MatchError", message: "match rejected" }
            : undefined,
        );
      }
      if (message.member === "Close") return callback(undefined);
      if (message.member !== "RequestBackground")
        throw new Error("Unexpected method " + message.member);
      const values = new Map(message.body![1] as [string, [string, unknown]][]);
      const token = values.get("handle_token")![1];
      if (typeof token !== "string") throw new Error("Invalid request token");
      const handle = "/org/freedesktop/portal/desktop/request/1_123/" + token;
      const enabled = values.get("autostart")![1] as boolean;
      const response: [string, unknown][] = [
        ["background", incoming("b", options.background ?? true)],
      ];
      if (!options.missingResult)
        response.push(["autostart", incoming("b", options.autostart ?? enabled)]);
      if (options.duplicate) response.push(["background", incoming("b", true)]);
      const emit = (sender = ":1.42") =>
        connection.emit("message", {
          type: 4,
          sender,
          path: handle,
          interface: "org.freedesktop.portal.Request",
          member: "Response",
          body: [options.code ?? 0, response],
        });
      if (options.wrongSenderFirst) emit(":1.666");
      if (options.early && !options.silent) emit();
      callback(undefined, options.badHandle ? handle + "_wrong" : handle);
      requestSeen();
      if (!options.early && !options.silent) queueMicrotask(() => emit());
    }),
  };
  return {
    bus,
    connection,
    stream,
    end,
    seen,
    matched: () => matchBeforeRequest,
    createBus: () => Promise.resolve(bus),
  };
}
test("session addresses support escaped paths, core abstract sockets and fallbacks", () => {
  expect(sessionBusPaths("unix:path=/run/user/1000/bus,guid=abc;unix:abstract=my%20bus")).toEqual([
    "/run/user/1000/bus",
    "\0my bus",
  ]);
  expect(sessionBusPaths("tcp:host=ignored;unix:path=/run/bus")).toEqual(["/run/bus"]);
});
test.each([
  "",
  "tcp:host=remote",
  "unix:path=relative",
  "unix:path=/run/a,abstract=b",
  "unix:path=/run/%00bus",
  "unix:path=%xx",
])("rejects an unusable session address: %s", (address) => {
  expect(() => sessionBusPaths(address)).toThrow();
});
test.each([true, false])(
  "subscribes before requesting and confirms autostart=%s",
  async (enabled) => {
    const f = fixture({ wrongSenderFirst: true });
    await requestLinuxBackground(
      { enabled, args: ["--start-minimized"], reason: "Inert test" },
      f.createBus,
    );
    expect(f.matched()).toBe(true);
    expect(f.end).toHaveBeenCalledTimes(1);
    const invoke = vi.mocked(f.bus.invoke);
    const message = invoke.mock.calls.find(
      ([message]) => message.member === "RequestBackground",
    )![0];
    const values = new Map(message.body![1] as [string, [string, unknown]][]);
    expect(values.get("commandline")).toEqual(["as", ["vortex", "--start-minimized"]]);
    expect(values.get("autostart")).toEqual(["b", enabled]);
    expect(invoke.mock.calls.some(([message]) => message.member === "Close")).toBe(false);
  },
);
test("the production request has a reason without an initialized translator", async () => {
  const f = fixture();
  await requestLinuxBackground({ enabled: true, args: [] }, f.createBus);
  const message = vi
    .mocked(f.bus.invoke)
    .mock.calls.find(([message]) => message.member === "RequestBackground")![0];
  const values = new Map(message.body![1] as [string, [string, unknown]][]);
  expect(values.get("reason")).toEqual(["s", "Start Vortex automatically when you log in"]);
  expect(f.end).toHaveBeenCalledTimes(1);
});

test("a response arriving before the method reply is retained", async () => {
  const f = fixture({ early: true });
  await requestLinuxBackground({ enabled: true, args: [], reason: "Inert test" }, f.createBus);
  expect(f.end).toHaveBeenCalledTimes(1);
});
test.each([
  { code: 1 },
  { background: false },
  { autostart: false },
  { missingResult: true },
  { duplicate: true },
])("denial or malformed results cannot grant automatic startup: %j", async (options) => {
  const f = fixture(options);
  await expect(
    requestLinuxBackground({ enabled: true, args: [], reason: "Inert test" }, f.createBus),
  ).rejects.toThrow();
  expect(f.end).toHaveBeenCalledTimes(1);
});
test("an unmatched sender cannot complete the request; timeout closes it", async () => {
  const f = fixture({ wrongSenderFirst: true, silent: true });
  await expect(
    requestLinuxBackground(
      { enabled: true, args: [], reason: "Inert test", timeoutMs: 25 },
      f.createBus,
    ),
  ).rejects.toThrow("timed out");
  expect(vi.mocked(f.bus.invoke).mock.calls.some(([message]) => message.member === "Close")).toBe(
    true,
  );
  expect(f.end).toHaveBeenCalledTimes(1);
});
test("closing the caller cancels its request and releases its bus", async () => {
  const f = fixture({ silent: true }),
    abort = new AbortController();
  const request = requestLinuxBackground(
    { enabled: true, args: [], reason: "Inert test", signal: abort.signal },
    f.createBus,
  );
  const rejection = expect(request).rejects.toThrow("caller closed");
  await f.seen;
  abort.abort(new Error("caller closed"));
  await rejection;
  expect(vi.mocked(f.bus.invoke).mock.calls.some(([message]) => message.member === "Close")).toBe(
    true,
  );
  expect(f.end).toHaveBeenCalledTimes(1);
});
test("a disconnected session bus rejects instead of waiting for permission forever", async () => {
  const f = fixture({ silent: true });
  const request = requestLinuxBackground(
    { enabled: true, args: [], reason: "Inert test" },
    f.createBus,
  );
  const rejection = expect(request).rejects.toThrow("disconnected");
  await f.seen;
  f.connection.emit("end");
  await rejection;
  expect(f.end).toHaveBeenCalledTimes(1);
});
test.each([{ badHandle: true }, { addMatchError: true }])(
  "method/setup failures close the dedicated bus: %j",
  async (options) => {
    const f = fixture(options);
    await expect(
      requestLinuxBackground({ enabled: true, args: [], reason: "Inert test" }, f.createBus),
    ).rejects.toThrow();
    expect(f.end).toHaveBeenCalledTimes(1);
  },
);
test("a pre-canceled request never opens a connection", async () => {
  const abort = new AbortController();
  abort.abort(new Error("already closed"));
  const create = vi.fn();
  await expect(
    requestLinuxBackground(
      { enabled: true, args: [], reason: "Inert test", signal: abort.signal },
      create,
    ),
  ).rejects.toThrow("already closed");
  expect(create).not.toHaveBeenCalled();
});
