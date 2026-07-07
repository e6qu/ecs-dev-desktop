// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Server } from "node:http";

export async function listenOnLoopback(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(addr.port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

export async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err === undefined) {
        resolve();
        return;
      }
      reject(err);
    });
  });
}
