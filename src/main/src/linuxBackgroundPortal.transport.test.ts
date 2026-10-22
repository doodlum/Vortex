import { once } from "node:events";
import fs from "node:fs";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { expect, test, vi } from "vitest";

import { createPortalBus } from "./linuxBackgroundPortal";

// Keep the real Node socket and production connection lifecycle; only replace
// the D-Bus handshake, which has separate private-daemon integration coverage.
vi.mock("@homebridge/dbus-native", () => ({
  default: { sessionBus: ({ stream }: { stream: unknown }) => ({ connection: { stream } }) },
}));

test.skipIf(process.platform === "win32")(
  "aborting an established connection preserves transport for portal Close",
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-bus-"));
    const socketPath = path.join(directory, "bus");
    const server = createServer();
    const previous = process.env.DBUS_SESSION_BUS_ADDRESS;
    const controller = new AbortController();
    let bus: Awaited<ReturnType<typeof createPortalBus>> | undefined;
    let peer: Socket | undefined;
    try {
      server.listen(socketPath);
      await once(server, "listening");
      const accepted = once(server, "connection");
      process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=" + socketPath;
      bus = await createPortalBus(controller.signal);
      [peer] = (await accepted) as [Socket];
      peer.on("error", () => {});
      controller.abort(new Error("caller closed"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(bus.connection.stream.destroyed).toBe(false);
      const received = once(peer, "data");
      bus.connection.stream.write("Close");
      expect(String((await received)[0])).toBe("Close");
    } finally {
      if (previous === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = previous;
      bus?.connection.stream.destroy();
      peer?.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
