// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { proxyWorkspaceUpgrade } from "./workspace-proxy";

// The WebSocket half of the `/w/<id>/` tunnel, end to end over real sockets.
//
// A WebSocket client that speaks first sends its opening frames in the SAME TCP
// segment as the upgrade request. Node's HTTP server hands those trailing bytes to
// the `upgrade` listener as `head` -- they are NOT in the socket's read queue, so a
// proxy that ignores `head` silently loses the client's first message, and the loss
// is invisible from outside (the upgrade still returns 101 and the socket stays
// open; the peer just waits forever).
//
// Relaying `head` currently rests on a subtlety worth pinning down: it is written to
// the ClientRequest, and that only reaches the wire unframed because Node skips
// chunked encoding for a GET carrying `Connection: Upgrade`. Give the same request a
// body-bearing method, or set a header that flips `useChunkedEncodingByDefault`, and
// those bytes would arrive chunk-framed instead -- corrupting the stream rather than
// erroring. The byte-for-byte assertions below fail on either outcome.
//
// Real servers and a real client socket rather than mocks, because the behaviour
// lives precisely in how Node splits a request between `head` and the stream.

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
});

const port = (s: Server): number => (s.address() as AddressInfo).port;
const listen = async (s: Server): Promise<Server> => {
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return s;
};

/** An upstream that upgrades and records every byte the client sends after it. */
interface Upstream {
  readonly server: Server;
  /** Everything received on the upgraded connection, `head` first. */
  received: () => Buffer;
  /** Resolves once at least `n` bytes have arrived. */
  waitFor: (n: number) => Promise<Buffer>;
  /** Bytes to emit with the 101 before the client is piped in. */
  greeting: Buffer;
}

async function startUpstream(greeting = Buffer.alloc(0)): Promise<Upstream> {
  const chunks: Buffer[] = [];
  const waiters: { n: number; resolve: (b: Buffer) => void }[] = [];
  const total = (): Buffer => Buffer.concat(chunks);
  const settle = (): void => {
    const buf = total();
    for (const w of waiters.splice(0)) {
      if (buf.length >= w.n) w.resolve(buf);
      else waiters.push(w);
    }
  };
  const server = createServer();
  server.on("upgrade", (_req, socket, head) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    );
    if (greeting.length > 0) socket.write(greeting);
    // `head` here is whatever arrived past the request the proxy sent us.
    if (head.length > 0) chunks.push(head);
    socket.on("data", (d: Buffer) => {
      chunks.push(d);
      settle();
    });
    settle();
  });
  await listen(server);
  return {
    server,
    greeting,
    received: total,
    waitFor: (n) =>
      new Promise((resolve) => {
        const buf = total();
        if (buf.length >= n) resolve(buf);
        else waiters.push({ n, resolve });
      }),
  };
}

/** The front door: upgrades are handed to the function under test. */
async function startProxy(upstream: Upstream): Promise<Server> {
  const target = new URL(`http://127.0.0.1:${String(port(upstream.server))}`);
  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    proxyWorkspaceUpgrade(target, req, socket, head);
  });
  return await listen(server);
}

/**
 * Send an upgrade request and `earlyBytes` in ONE write, so Node's server parser
 * delivers `earlyBytes` to the proxy as `head` rather than as stream data. Returns
 * the client socket and a promise for what the proxy writes back.
 */
function speakFirst(
  proxyPort: number,
  earlyBytes: Buffer,
): { socket: Socket; response: () => Buffer; waitFor: (n: number) => Promise<Buffer> } {
  const socket = connect(proxyPort, "127.0.0.1");
  sockets.push(socket);
  const chunks: Buffer[] = [];
  const waiters: { n: number; resolve: (b: Buffer) => void }[] = [];
  const total = (): Buffer => Buffer.concat(chunks);
  socket.on("data", (d: Buffer) => {
    chunks.push(d);
    const buf = total();
    for (const w of waiters.splice(0)) {
      if (buf.length >= w.n) w.resolve(buf);
      else waiters.push(w);
    }
  });
  socket.on("connect", () => {
    socket.write(
      Buffer.concat([
        Buffer.from(
          "GET /w/ws-test/socket HTTP/1.1\r\n" +
            "host: app.example\r\n" +
            "upgrade: websocket\r\n" +
            "connection: Upgrade\r\n" +
            "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "sec-websocket-version: 13\r\n\r\n",
        ),
        earlyBytes,
      ]),
    );
  });
  return {
    socket,
    response: total,
    waitFor: (n) =>
      new Promise((resolve) => {
        const buf = total();
        if (buf.length >= n) resolve(buf);
        else waiters.push({ n, resolve });
      }),
  };
}

describe("proxyWorkspaceUpgrade", () => {
  it("relays the client's pre-upgrade bytes to the upstream verbatim", async () => {
    // A plausible stand-in for VS Code's first message: a masked binary frame. The
    // exact content is irrelevant -- what matters is that it survives byte for byte.
    const early = Buffer.from([0x82, 0x85, 0x01, 0x02, 0x03, 0x04, 0x69, 0x67, 0x6f, 0x68, 0x62]);
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream);

    const client = speakFirst(port(proxy), early);
    const got = await upstream.waitFor(early.length);

    // Byte-for-byte, and nothing else: chunk framing would make these arrive as
    // `b\r\n<bytes>\r\n0\r\n\r\n` -- longer, not absent -- so equality catches
    // corruption as well as total loss.
    expect(got).toEqual(early);
    await expect(client.waitFor(12)).resolves.toBeDefined();
    expect(client.response().toString("latin1")).toMatch(/^HTTP\/1\.1 101 /);
  });

  it("still relays client bytes that arrive after the upgrade completes", async () => {
    const early = Buffer.from("FIRST");
    const later = Buffer.from("SECOND");
    const upstream = await startUpstream();
    const proxy = await startProxy(upstream);

    const client = speakFirst(port(proxy), early);
    await upstream.waitFor(early.length);
    client.socket.write(later);

    // Ordering matters as much as delivery: a proxy that appends `head` after
    // piping would deliver SECOND before FIRST and corrupt the frame stream.
    await expect(upstream.waitFor(early.length + later.length)).resolves.toEqual(
      Buffer.concat([early, later]),
    );
  });

  it("relays the upstream's own pre-pipe bytes back to the client", async () => {
    const greeting = Buffer.from([0x81, 0x03, 0x68, 0x69]);
    const upstream = await startUpstream(greeting);
    const proxy = await startProxy(upstream);

    const client = speakFirst(port(proxy), Buffer.alloc(0));
    const buf = await client.waitFor(greeting.length + 12);
    const body = buf.subarray(buf.indexOf("\r\n\r\n") + 4);

    expect(body).toEqual(greeting);
  });
});
