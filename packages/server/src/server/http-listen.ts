import { existsSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";

export type HttpListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

export function listenHttpServer(server: Server, listenTarget: HttpListenTarget): Promise<void> {
  return new Promise((resolve, reject) => {
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
      if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
        unlinkSync(listenTarget.path);
      }
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
  if (listenTarget?.type === "socket" && existsSync(listenTarget.path)) {
    unlinkSync(listenTarget.path);
  }
}
