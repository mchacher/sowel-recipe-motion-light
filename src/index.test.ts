import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRecipe,
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

// ============================================================
// Regression: periodic state re-reports must not reset the off-timer
// (a relay that re-publishes "state: ON" every 60s kept the light on forever)
// ============================================================

const ZONE = "zone-1";
const LIGHT = "light-1";

/** Minimal event/equipment harness driving a real recipe instance. */
function makeInstanceHarness() {
  const handlers: Record<string, Array<(e: Record<string, unknown>) => void>> = {};
  let lightPhysicallyOn = false; // what the bulb reports
  let motion = false;

  const emit = (type: string, event: Record<string, unknown>) => {
    for (const h of handlers[type] ?? []) h(event);
  };

  const ctx = {
    eventBus: {
      onType(type: string, handler: (e: Record<string, unknown>) => void) {
        (handlers[type] ??= []).push(handler);
        return () => {
          handlers[type] = (handlers[type] ?? []).filter((h) => h !== handler);
        };
      },
    },
    equipmentManager: {
      getByIdWithDetails: () => ({
        name: "Light",
        type: "light_onoff",
        zoneId: ZONE,
        dataBindings: [{ alias: "state" }],
        orderBindings: [{ alias: "state" }],
      }),
      getByZone: () => [],
      getDataBindingsWithValues: () => [],
      executeOrder: async () => {},
    },
    zoneManager: {
      getById: () => ({ id: ZONE, name: "Zone" }),
      getDescendantIds: (id: string) => [id],
    },
    zoneAggregator: {
      getByZoneId: () => ({ motion, motionSensors: 1, luminosity: null, isDaylight: null }),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    state: (() => {
      const m = new Map<string, unknown>();
      return {
        get: (k: string) => (m.has(k) ? m.get(k) : null),
        set: (k: string, v: unknown) => void m.set(k, v),
        delete: (k: string) => void m.delete(k),
        clear: () => m.clear(),
      };
    })(),
    log: () => {},
    helpers: {
      isAnyLightOn: () => lightPhysicallyOn,
      turnOnLights: () => {
        lightPhysicallyOn = true;
        return [];
      },
      turnOffLights: () => {
        lightPhysicallyOn = false;
        return [];
      },
      setLightsBrightness: () => [],
      parseDuration: (v: unknown) => {
        const m = /^(\d+)(s|m|h)$/.exec(String(v));
        if (!m) throw new Error(`bad duration: ${String(v)}`);
        const n = Number(m[1]);
        return m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60000 : n * 3600000;
      },
      formatDuration: (ms: number) => `${ms}ms`,
    },
  } as unknown as RecipeContext;

  return {
    ctx,
    isLightOn: () => lightPhysicallyOn,
    setMotion: (v: boolean) => {
      motion = v;
    },
    emitZone(aggregatedData: Record<string, unknown>) {
      emit("zone.data.changed", { zoneId: ZONE, aggregatedData });
    },
    /** Simulate the bulb publishing its state (value unchanged = a heartbeat). */
    reportLight(on: boolean) {
      lightPhysicallyOn = on;
      emit("equipment.data.changed", { equipmentId: LIGHT, alias: "state", value: on ? "ON" : "OFF" });
    },
  };
}

describe("periodic light-state re-reports (regression)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms the off-timer once on external ON and turns off after timeout despite ON heartbeats", () => {
    const h = makeInstanceHarness();
    const inst = createRecipe().createInstance(
      { zone: ZONE, lights: [LIGHT], timeout: "2m" },
      h.ctx,
    );

    // Light turns on externally, no motion -> off-timer armed for 2m.
    h.reportLight(true);
    expect(h.isLightOn()).toBe(true);

    // 1 minute passes, then the bulb re-publishes "ON" (a heartbeat).
    vi.advanceTimersByTime(60_000);
    h.reportLight(true); // <-- must be ignored, must NOT reset the 2m countdown
    vi.advanceTimersByTime(60_000);

    // 2 minutes total since the real turn-on -> light must be OFF.
    expect(h.isLightOn()).toBe(false);
    inst.stop();
  });

  it("a genuine OFF then ON transition is still honoured", () => {
    const h = makeInstanceHarness();
    const inst = createRecipe().createInstance(
      { zone: ZONE, lights: [LIGHT], timeout: "2m" },
      h.ctx,
    );

    h.reportLight(true); // external ON -> 2m countdown
    vi.advanceTimersByTime(130_000); // elapse -> off
    expect(h.isLightOn()).toBe(false);

    h.reportLight(true); // a NEW external ON (real transition) -> fresh 2m
    vi.advanceTimersByTime(60_000);
    h.reportLight(true); // heartbeat, ignored
    vi.advanceTimersByTime(60_000);
    expect(h.isLightOn()).toBe(false); // off at 2m, heartbeat did not extend it
    inst.stop();
  });
});

describe("empty lux threshold (issue #307 regression)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("an empty lux field is treated as 'no threshold', not 0, so a luminosity-reporting sensor still turns on", () => {
    const h = makeInstanceHarness();
    // Empty SEUIL LUX from the UI arrives as "" — Number("") is 0, which used to
    // block any sensor reporting >0 lx (e.g. Sonoff SNZB-03PR2 at 1 lx) while a
    // motion-only sensor (luminosity null) worked.
    const inst = createRecipe().createInstance(
      { zone: ZONE, lights: [LIGHT], timeout: "2m", luxThreshold: "" },
      h.ctx,
    );
    expect(h.isLightOn()).toBe(false);

    h.emitZone({ motion: true, luminosity: 1 });

    expect(h.isLightOn()).toBe(true);
    inst.stop();
  });

  it("a real lux threshold still blocks turn-on above it", () => {
    const h = makeInstanceHarness();
    const inst = createRecipe().createInstance(
      { zone: ZONE, lights: [LIGHT], timeout: "2m", luxThreshold: 50 },
      h.ctx,
    );

    h.emitZone({ motion: true, luminosity: 120 }); // brighter than 50 -> stay off
    expect(h.isLightOn()).toBe(false);
    inst.stop();
  });
});
