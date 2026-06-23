// SPDX-License-Identifier: AGPL-3.0-or-later
// The visitor's own API key for the opt-in REAL agent mode. Held in sessionStorage (per-tab,
// cleared when the tab closes) — never localStorage, never sent anywhere but the provider's API
// directly from the browser. The reset widget also clears it.
import type { AgentKind } from "./demo-types";

export type Provider = "anthropic" | "openai";

export function providerFor(agent: AgentKind): Provider {
  return agent === "claude-code" ? "anthropic" : "openai";
}

export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const storeKey = (p: Provider): string => `edd-demo:agent-key:${p}`;

export function getKey(provider: Provider): string | null {
  return sessionStorage.getItem(storeKey(provider));
}

export function setKey(provider: Provider, key: string): void {
  sessionStorage.setItem(storeKey(provider), key);
}

export function clearKeys(): void {
  sessionStorage.removeItem(storeKey("anthropic"));
  sessionStorage.removeItem(storeKey("openai"));
}
