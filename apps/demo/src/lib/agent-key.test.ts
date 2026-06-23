// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from "vitest";

// sessionStorage shim for the node test env.
class MemStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
}
globalThis.sessionStorage = new MemStorage();

const { clearKeys, getKey, providerFor, setKey } = await import("./agent-key");

describe("agent-key", () => {
  beforeEach(() => {
    globalThis.sessionStorage.clear();
  });

  it("maps agents to providers", () => {
    expect(providerFor("claude-code")).toBe("anthropic");
    expect(providerFor("codex")).toBe("openai");
  });

  it("stores + reads a key per provider, and clears both", () => {
    expect(getKey("anthropic")).toBeNull();
    setKey("anthropic", "sk-ant");
    setKey("openai", "sk-oai");
    expect(getKey("anthropic")).toBe("sk-ant");
    expect(getKey("openai")).toBe("sk-oai");
    clearKeys();
    expect(getKey("anthropic")).toBeNull();
    expect(getKey("openai")).toBeNull();
  });
});
