// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  HealthStatusDto,
  LogLineDto,
  LogStreamDto,
  WorkspaceStateDto,
} from "@edd/api-contracts";
import type { HealthStatus, LogLevel, LogStream, WorkspaceState } from "@edd/core";
import { describe, expectTypeOf, it } from "vitest";

/**
 * Compile-time alignment between the Zod API contracts (`@edd/api-contracts`) and
 * the core domain unions (`@edd/core`). Each pair is defined independently — a
 * `z.enum([...])` on the wire and a string union in the domain — so without these
 * checks one could silently drift from the other. They run at type-check time and
 * cannot flake. Add or remove a variant on one side and a check stops compiling.
 */
describe("contract ↔ domain alignment (type-level)", () => {
  it("workspace state enum matches the core union", () => {
    expectTypeOf<WorkspaceStateDto>().toEqualTypeOf<WorkspaceState>();
  });

  it("health status enum matches the core union", () => {
    expectTypeOf<HealthStatusDto>().toEqualTypeOf<HealthStatus>();
  });

  it("log stream enum matches the core union", () => {
    expectTypeOf<LogStreamDto>().toEqualTypeOf<LogStream>();
  });

  it("log level enum matches the core union", () => {
    expectTypeOf<LogLineDto["level"]>().toEqualTypeOf<LogLevel>();
  });
});
