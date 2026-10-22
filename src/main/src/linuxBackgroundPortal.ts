import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";

import dbus from "@homebridge/dbus-native";

const DESTINATION = "org.freedesktop.portal.Desktop";
const PATH = "/org/freedesktop/portal/desktop";
const REQUEST = "org.freedesktop.portal.Request";
const BACKGROUND = "org.freedesktop.portal.Background";

interface IBusMessage {
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature?: string;
  body?: unknown[];
}
export interface IPortalBus {
  name?: string;
  connection: EventEmitter & { stream: Socket };
  invoke: (message: IBusMessage, callback: (error: unknown, value?: unknown) => void) => void;
}
export interface IBackgroundRequest {
  enabled: boolean;
  args: string[];
  reason?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  if (record(value) && typeof value.message === "string") {
    return new Error((typeof value.name === "string" ? value.name + ": " : "") + value.message);
  }
  return new Error(fallback);
}

/** dbus-native's incoming variants contain a signature tree and one-element body. */
function variant(value: unknown, type: string): unknown {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const tuple: unknown[] = value;
  const signature = tuple[0],
    body = tuple[1];
  if (
    !Array.isArray(signature) ||
    signature.length !== 1 ||
    !record(signature[0]) ||
    signature[0].type !== type ||
    !Array.isArray(body) ||
    body.length !== 1
  )
    return undefined;
  return body[0];
}

export function sessionBusPaths(address: string): string[] {
  const paths: string[] = [];
  for (const entry of address.split(";")) {
    if (!entry.startsWith("unix:")) continue;
    const values = new Map(
      entry
        .slice(5)
        .split(",")
        .map((field) => {
          const index = field.indexOf("=");
          if (index <= 0) throw new Error("Invalid desktop bus address");
          return [field.slice(0, index), decodeURIComponent(field.slice(index + 1))];
        }),
    );
    const pathname = values.get("path"),
      abstract = values.get("abstract");
    if ((pathname !== undefined) === (abstract !== undefined))
      throw new Error("Invalid Unix desktop bus address");
    const value = pathname ?? abstract!;
    if (!value || value.includes("\0") || (pathname !== undefined && !pathname.startsWith("/")))
      throw new Error("Invalid desktop bus path");
    paths.push(pathname ?? "\0" + abstract);
  }
  if (paths.length === 0)
    throw new Error("A Unix desktop session bus is required for automatic startup");
  return paths;
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(asError(signal.reason, "Automatic startup request canceled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function closeBus(bus: IPortalBus): void {
  const stream = bus.connection.stream;
  // Closing errors cannot change an already settled request or crash the app.
  bus.connection.on("error", () => {});
  if (stream.destroyed) return;
  stream.end();
  const timeout = setTimeout(() => stream.destroy(), 100);
  timeout.unref();
  stream.once("close", () => clearTimeout(timeout));
}

export async function createPortalBus(signal: AbortSignal): Promise<IPortalBus> {
  const paths = sessionBusPaths(process.env.DBUS_SESSION_BUS_ADDRESS ?? "");
  let lastError: unknown;
  for (const path of paths) {
    signal.throwIfAborted();
    // Cancellation must stop connecting without destroying an established bus:
    // a pending portal request still needs its Close call on that connection.
    const stream = createConnection({ path });
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          stream.off("connect", connected);
          stream.off("error", failed);
          signal.removeEventListener("abort", aborted);
        };
        const connected = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const aborted = () => {
          cleanup();
          stream.destroy();
          reject(asError(signal.reason, "Automatic startup request canceled"));
        };
        stream.once("connect", connected);
        stream.once("error", failed);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
      // The published types omit sessionBus/stream options present in the pinned JS API.
      // Use core Node for abstract sockets instead of an optional native addon.
      const client = dbus as unknown as { sessionBus: (options: { stream: Socket }) => IPortalBus };
      if (typeof client.sessionBus !== "function")
        throw new Error("The desktop bus client is unavailable");
      return client.sessionBus({ stream });
    } catch (error) {
      stream.on("error", () => {});
      stream.destroy();
      lastError = error;
      signal.throwIfAborted();
    }
  }
  throw asError(lastError, "Unable to connect to the desktop session bus");
}

/** Direct sandbox bus call: the portal determines the app ID and owns all startup writes. */
export async function requestLinuxBackground(
  options: IBackgroundRequest,
  createBus: (signal: AbortSignal) => Promise<IPortalBus> = createPortalBus,
): Promise<void> {
  const controller = new AbortController(),
    signal = controller.signal;
  const externalAbort = () =>
    controller.abort(options.signal?.reason ?? new Error("Automatic startup request canceled"));
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  const timer = setTimeout(
    () => controller.abort(new Error("The desktop automatic startup request timed out")),
    options.timeoutMs ?? 120000,
  );
  timer.unref();
  let bus: IPortalBus | undefined,
    requestHandle: string | undefined,
    requestStarted = false,
    responseReceived = false;
  const failConnection = (error?: unknown) =>
    controller.abort(error ?? new Error("The desktop session bus disconnected"));
  let listener: ((message: unknown) => void) | undefined;
  try {
    signal.throwIfAborted();
    const connecting = createBus(signal);
    connecting.then(
      (value) => {
        if (signal.aborted) closeBus(value);
      },
      () => {},
    );
    bus = await abortable(connecting, signal);
    bus.connection.on("error", failConnection);
    bus.connection.on("end", failConnection);
    bus.connection.on("close", failConnection);
    const invoke = (message: IBusMessage) =>
      abortable(
        new Promise<unknown>((resolve, reject) => {
          bus!.invoke(message, (error, value) => {
            if (error) reject(asError(error, "Desktop bus error"));
            else resolve(value);
          });
        }),
        signal,
      );
    const dbusBase = {
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
    };
    await invoke({ ...dbusBase, member: "GetId" });
    if (!bus.name || !/^:[0-9]+(?:\.[0-9]+)+$/.test(bus.name))
      throw new Error("The desktop bus did not assign an identity");
    const version = variant(
      await invoke({
        destination: DESTINATION,
        path: PATH,
        interface: "org.freedesktop.DBus.Properties",
        member: "Get",
        signature: "ss",
        body: [BACKGROUND, "version"],
      }),
      "u",
    );
    if (typeof version !== "number" || version < 1)
      throw new Error("The Background desktop portal is unavailable");
    const owner = await invoke({
      ...dbusBase,
      member: "GetNameOwner",
      signature: "s",
      body: [DESTINATION],
    });
    if (typeof owner !== "string") throw new Error("The desktop portal has no bus owner");
    const token = "vortex_" + randomBytes(16).toString("hex");
    const prefix = PATH + "/request/" + bus.name.slice(1).replace(/\./g, "_") + "/";
    requestHandle = prefix + token;
    let receive!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      receive = resolve;
    });
    listener = (message) => {
      if (
        record(message) &&
        message.type === 4 &&
        message.sender === owner &&
        message.path === requestHandle &&
        message.interface === REQUEST &&
        message.member === "Response"
      )
        receive(message.body);
    };
    bus.connection.on("message", listener);
    await invoke({
      ...dbusBase,
      member: "AddMatch",
      signature: "s",
      body: [
        `type='signal',sender='${DESTINATION}',interface='${REQUEST}',member='Response',path='${requestHandle}'`,
      ],
    });
    requestStarted = true;
    const returnedHandle = await invoke({
      destination: DESTINATION,
      path: PATH,
      interface: BACKGROUND,
      member: "RequestBackground",
      signature: "sa{sv}",
      body: [
        "",
        [
          ["handle_token", ["s", token]],
          ["reason", ["s", options.reason ?? "Start Vortex automatically when you log in"]],
          ["autostart", ["b", options.enabled]],
          ["commandline", ["as", ["vortex", ...options.args]]],
          ["dbus-activatable", ["b", false]],
        ],
      ],
    });
    if (returnedHandle !== requestHandle) {
      if (typeof returnedHandle === "string" && returnedHandle.startsWith(prefix))
        requestHandle = returnedHandle;
      throw new Error("The desktop portal returned an unexpected request handle");
    }
    const body = await abortable(response, signal);
    responseReceived = true;
    if (!Array.isArray(body) || body.length !== 2 || !Array.isArray(body[1]))
      throw new Error("Invalid automatic startup portal response");
    if (body[0] !== 0) throw new Error("Automatic startup was not enabled by the desktop");
    const results = new Map<string, unknown>();
    for (const row of body[1]) {
      if (
        !Array.isArray(row) ||
        row.length !== 2 ||
        typeof row[0] !== "string" ||
        results.has(row[0])
      )
        throw new Error("Invalid automatic startup portal results");
      results.set(row[0], row[1]);
    }
    if (
      variant(results.get("background"), "b") !== true ||
      variant(results.get("autostart"), "b") !== options.enabled
    )
      throw new Error("The desktop did not permit the automatic startup change");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", externalAbort);
    if (bus) {
      if (requestStarted && !responseReceived && requestHandle) {
        // Give the portal a bounded opportunity to acknowledge cancellation
        // before releasing the dedicated connection, even after signal abort.
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 250);
          const finished = () => {
            clearTimeout(timeout);
            resolve();
          };
          try {
            bus!.invoke(
              {
                destination: DESTINATION,
                path: requestHandle!,
                interface: REQUEST,
                member: "Close",
              },
              finished,
            );
          } catch {
            finished();
          }
        });
      }
      if (listener) bus.connection.off("message", listener);
      bus.connection.off("error", failConnection);
      bus.connection.off("end", failConnection);
      bus.connection.off("close", failConnection);
      closeBus(bus);
    }
  }
}
