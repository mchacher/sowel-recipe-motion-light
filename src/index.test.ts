import { describe, it, expect } from "vitest";
import {
  isMotionActive,
  motionSourceKey,
  resolveMotionSources,
  type RecipeContext,
} from "./index.js";

describe("isMotionActive", () => {
  it("treats boolean true / truthy numbers / common strings as active", () => {
    for (const v of [true, 1, 5, "true", "TRUE", "on", "On", "1", "occupied", "detected"]) {
      expect(isMotionActive(v)).toBe(true);
    }
  });

  it("treats false / zero / cleared strings as inactive", () => {
    for (const v of [false, 0, "false", "off", "0", "clear", "", null, undefined]) {
      expect(isMotionActive(v)).toBe(false);
    }
  });
});

describe("motionSourceKey", () => {
  it("is stable and distinct per (deviceId, key)", () => {
    expect(motionSourceKey("dev-1", "occupancy")).toBe(motionSourceKey("dev-1", "occupancy"));
    expect(motionSourceKey("dev-1", "occupancy")).not.toBe(motionSourceKey("dev-2", "occupancy"));
    expect(motionSourceKey("dev-1", "occupancy")).not.toBe(motionSourceKey("dev-1", "motion"));
  });
});

describe("resolveMotionSources", () => {
  // Two PIRs (one per device) bound in the zone, plus a non-motion binding and a
  // disabled equipment that must be ignored. A descendant zone contributes too.
  function makeCtx(): RecipeContext {
    const equipments: Record<string, Array<{ id: string; enabled: boolean }>> = {
      "zone-atelier": [
        { id: "eq-pir-0", enabled: true },
        { id: "eq-pir-1", enabled: true },
        { id: "eq-light", enabled: true },
        { id: "eq-pir-off", enabled: false },
      ],
      "zone-child": [{ id: "eq-pir-2", enabled: true }],
    };
    const bindings: Record<string, Array<{ alias: string; category?: string; value: unknown; deviceId?: string; key?: string }>> = {
      "eq-pir-0": [{ alias: "motion", category: "motion", value: true, deviceId: "dev-0", key: "occupancy" }],
      "eq-pir-1": [{ alias: "motion", category: "motion", value: false, deviceId: "dev-1", key: "occupancy" }],
      "eq-light": [{ alias: "state", category: "light_onoff", value: false, deviceId: "dev-light", key: "state" }],
      "eq-pir-off": [{ alias: "motion", category: "motion", value: true, deviceId: "dev-off", key: "occupancy" }],
      "eq-pir-2": [{ alias: "motion", category: "motion", value: true, deviceId: "dev-2", key: "presence" }],
    };
    return {
      zoneManager: {
        getById: () => null,
        getDescendantIds: (id: string) => (id === "zone-atelier" ? ["zone-atelier", "zone-child"] : [id]),
      },
      equipmentManager: {
        getByZone: (zid: string) => equipments[zid] ?? [],
        getDataBindingsWithValues: (eqId: string) => bindings[eqId] ?? [],
      },
    } as unknown as RecipeContext;
  }

  it("collects motion device-data across the zone + descendants, skipping non-motion and disabled", () => {
    const sources = resolveMotionSources(makeCtx(), "zone-atelier");
    expect(sources.has(motionSourceKey("dev-0", "occupancy"))).toBe(true);
    expect(sources.has(motionSourceKey("dev-1", "occupancy"))).toBe(true);
    expect(sources.has(motionSourceKey("dev-2", "presence"))).toBe(true); // descendant zone
    expect(sources.has(motionSourceKey("dev-light", "state"))).toBe(false); // not motion
    expect(sources.has(motionSourceKey("dev-off", "occupancy"))).toBe(false); // disabled equipment
    expect(sources.size).toBe(3);
  });

  it("falls back to the zone itself when getDescendantIds throws", () => {
    const ctx = makeCtx();
    (ctx.zoneManager as { getDescendantIds: (id: string) => string[] }).getDescendantIds = () => {
      throw new Error("not available");
    };
    const sources = resolveMotionSources(ctx, "zone-atelier");
    // Only the atelier zone's two enabled PIRs (no descendant)
    expect(sources.has(motionSourceKey("dev-0", "occupancy"))).toBe(true);
    expect(sources.has(motionSourceKey("dev-2", "presence"))).toBe(false);
    expect(sources.size).toBe(2);
  });
});
