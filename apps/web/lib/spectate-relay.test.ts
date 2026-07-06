// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  NO_PUBLISHER_CODE,
  SHARING_ENDED_CODE,
  SpectateRelay,
  type RelaySocket,
} from "./spectate-relay";

function fakeSocket(): RelaySocket & { sent: string[]; closedWith: number | undefined } {
  const sock = {
    sent: [] as string[],
    closedWith: undefined as number | undefined,
    send(data: string) {
      sock.sent.push(data);
    },
    close(code?: number) {
      sock.closedWith = code;
    },
  };
  return sock;
}

const WS = "ws-spec-1";
const frame = (t: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ t, ...extra });

describe("SpectateRelay", () => {
  it("fans published frames out to every subscriber", () => {
    const relay = new SpectateRelay();
    relay.publish(WS, fakeSocket());
    const a = fakeSocket();
    const b = fakeSocket();
    relay.subscribe(WS, a);
    relay.subscribe(WS, b);
    relay.forward(WS, frame("term", { data: "$ ls\r\n" }));
    expect(a.sent).toEqual([frame("term", { data: "$ ls\r\n" })]);
    expect(b.sent).toEqual([frame("term", { data: "$ ls\r\n" })]);
  });

  it("replays the cached snapshot to a late joiner (but never terminal output — no scrollback backfill)", () => {
    const relay = new SpectateRelay();
    relay.publish(WS, fakeSocket());
    relay.forward(WS, frame("file", { path: "a.ts", content: "x" }));
    relay.forward(WS, frame("cursor", { line: 3, col: 1 }));
    relay.forward(WS, frame("term", { data: "secret-history" }));
    const late = fakeSocket();
    relay.subscribe(WS, late);
    expect(late.sent).toContain(frame("file", { path: "a.ts", content: "x" }));
    expect(late.sent).toContain(frame("cursor", { line: 3, col: 1 }));
    expect(late.sent.some((f) => f.includes("secret-history"))).toBe(false);
  });

  it("subscribe with no publisher returns null (caller closes with NO_PUBLISHER_CODE for client retry)", () => {
    const relay = new SpectateRelay();
    expect(relay.subscribe(WS, fakeSocket())).toBeNull();
    expect(NO_PUBLISHER_CODE).toBe(4404);
  });

  it("publisher close ends every subscriber with SHARING_ENDED_CODE and tears the channel down", () => {
    const relay = new SpectateRelay();
    const unpublish = relay.publish(WS, fakeSocket());
    const sub = fakeSocket();
    relay.subscribe(WS, sub);
    unpublish();
    expect(sub.closedWith).toBe(SHARING_ENDED_CODE);
    expect(relay.hasPublisher(WS)).toBe(false);
  });

  it("a newer publisher replaces the old one without dropping subscribers — and the OLD socket's late close is a no-op", () => {
    const relay = new SpectateRelay();
    const oldPub = fakeSocket();
    const unpublishOld = relay.publish(WS, oldPub);
    const sub = fakeSocket();
    relay.subscribe(WS, sub);

    relay.publish(WS, fakeSocket()); // e.g. the owner reloaded the editor tab
    expect(oldPub.closedWith).toBe(1000);
    unpublishOld(); // the replaced socket's close handler fires late
    expect(relay.hasPublisher(WS)).toBe(true); // successor unaffected
    expect(sub.closedWith).toBeUndefined(); // subscriber kept streaming

    relay.forward(WS, frame("focus", { focused: true, visible: true }));
    expect(sub.sent).toContain(frame("focus", { focused: true, visible: true }));
  });

  it("drops non-JSON frames instead of relaying garbage", () => {
    const relay = new SpectateRelay();
    relay.publish(WS, fakeSocket());
    const sub = fakeSocket();
    relay.subscribe(WS, sub);
    relay.forward(WS, "not json {");
    expect(sub.sent).toEqual([]);
  });

  it("unsubscribe detaches only that spectator", () => {
    const relay = new SpectateRelay();
    relay.publish(WS, fakeSocket());
    const a = fakeSocket();
    const b = fakeSocket();
    const offA = relay.subscribe(WS, a);
    relay.subscribe(WS, b);
    offA?.();
    relay.forward(WS, frame("mouse", { x: 0.5, y: 0.5 }));
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([frame("mouse", { x: 0.5, y: 0.5 })]);
    expect(relay.subscriberCount(WS)).toBe(1);
  });
});
