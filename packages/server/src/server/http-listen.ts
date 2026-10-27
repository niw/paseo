import { rm } from "node:fs/promises";
import type { Server } from "node:http";

import type { ListenTarget } from "./listeners.js";

// The gateway shares the daemon's listen syntax; listeners.ts loads only Node built-ins.
export { parseListenString } from "./listeners.js";
export type HttpListenTarget = ListenTarget;

export async function listenHttpServer(
  server: Server,
  listenTarget: HttpListenTarget,
): Promise<void> {
  if (listenTarget.type === "socket") {
    await rm(listenTarget.path, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (listenTarget.type === "tcp") {
      server.listen(listenTarget.port, listenTarget.host);
    } else {
      server.listen(listenTarget.path);
    }
  });
}

/** Replaces a requested port 0 with the port the OS assigned. */
export function resolveBoundListenTarget(
  listenTarget: HttpListenTarget,
  httpServer: Server,
): HttpListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }
  return { type: "tcp", host: listenTarget.host, port: address.port };
}

export async function closeHttpServer(
  server: Server,
  listenTarget: HttpListenTarget | null,
): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (listenTarget?.type === "socket") {
    await rm(listenTarget.path, { force: true });
  }
}
