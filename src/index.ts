// ============================================================
// Motion-Light Recipe — external package
// ============================================================

// Minimal types for RecipeContext (injected at runtime by Sowel core)
interface RecipeContext {
  eventBus: {
    onType(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  };
  equipmentManager: {
    getByIdWithDetails(id: string): {
      name: string;
      type: string;
      zoneId?: string;
      dataBindings: Array<{ alias: string }>;
      orderBindings: Array<{ alias: string; enumValues?: string[] }>;
    } | null;
    getDataBindingsWithValues(id: string): Array<{ alias: string; category?: string; value: unknown }>;
    executeOrder(equipmentId: string, alias: string, value: unknown): Promise<void>;
  };
  zoneManager: {
    getById(id: string): { id: string; name: string } | null;
  };
  zoneAggregator: {
    getByZoneId(zoneId: string): {
      motion: boolean;
      motionSensors: number;
      luminosity: number | null;
      isDaylight?: boolean | null;
    } | null;
  };
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    debug(obj: Record<string, unknown>, msg?: string): void;
  };
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    clear(): void;
  };
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    isAnyLightOn(lightIds: string[], ctx: RecipeContext): boolean;
    turnOnLights(lightIds: string[], ctx: RecipeContext): string[];
    turnOffLights(lightIds: string[], ctx: RecipeContext): string[];
    setLightsBrightness(lightIds: string[], ctx: RecipeContext, brightness: number): string[];
    parseDuration(value: unknown): number;
    formatDuration(ms: number): string;
  };
}

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
  };
  group?: string;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, { name: string; description: string }>;
  groups?: Record<string, string>;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  actions?: unknown[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(
    params: Record<string, unknown>,
    ctx: RecipeContext,
  ): { stop(): void; onAction?(action: string, payload?: Record<string, unknown>): void };
}

// ============================================================
// Constants
// ============================================================

/** Well-known ID for the root zone "Maison". */
const ROOT_ZONE_ID = "00000000-0000-0000-0000-000000000001";

/** Hysteresis factor to prevent lux-based on/off oscillation.
 *  Turn-on: lux <= threshold.  Turn-off: lux > threshold * (1 + factor). */
const LUX_HYSTERESIS_FACTOR = 0.1;

/**
 * After the recipe sends an OFF order, ignore for this many ms any echo or
 * downstream zone event that might re-trigger a turn-on. Has to cover the
 * MQTT round-trip from the bulb. 2s is plenty for zigbee2mqtt.
 */
const TURN_OFF_GRACE_MS = 2000;

// ============================================================
// Helpers
// ============================================================

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((id): id is string => typeof id === "string");
  }
  if (typeof value === "string" && value.length > 0) {
    return value.split(",").filter(Boolean);
  }
  return [];
}

function normalizeLights(params: Record<string, unknown>): string[] {
  if (Array.isArray(params.lights)) {
    return params.lights.filter((id): id is string => typeof id === "string");
  }
  // Backward compat: single "light" param
  if (typeof params.light === "string") {
    return [params.light];
  }
  return [];
}

// ============================================================
// Slot definitions
// ============================================================

function baseSlots(): RecipeSlotDef[] {
  return [
    {
      id: "zone",
      name: "Zone",
      description: "Zone to monitor",
      type: "zone",
      required: true,
    },
  ];
}

function commonTrailingSlots(): RecipeSlotDef[] {
  return [
    {
      id: "timeout",
      name: "Timeout",
      description: "Delay with no motion before turning off",
      type: "duration",
      required: true,
      defaultValue: "10m",
    },
    {
      id: "luxThreshold",
      name: "Lux Threshold",
      description:
        "Lights won't turn on when ambient brightness exceeds this value; turns off if it rises above threshold + 10% hysteresis",
      type: "number",
      required: false,
      constraints: { min: 0 },
    },
    {
      id: "maxOnDuration",
      name: "Safety Auto-off",
      description: "Force lights off after this duration even with continued motion (failsafe)",
      type: "duration",
      required: false,
    },
    {
      id: "buttons",
      name: "Manual Switches",
      description: "Physical switches for manual on/off toggle",
      type: "equipment",
      required: false,
      list: true,
      constraints: { equipmentType: "button" },
    },
    {
      id: "disableWhenDaylight",
      name: "Inactive During Day",
      description:
        "Do not turn on lights during daytime (based on sunrise/sunset and offsets from settings)",
      type: "boolean",
      required: false,
    },
  ];
}

// ============================================================
// Recipe Definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  const lightsSlot: RecipeSlotDef = {
    id: "lights",
    name: "Lights",
    description: "Lights to control (must belong to the selected zone)",
    type: "equipment",
    required: true,
    list: true,
    constraints: { equipmentType: "light_onoff" },
  };

  const allowedTypes = lightsSlot.constraints?.equipmentType
    ? Array.isArray(lightsSlot.constraints.equipmentType)
      ? lightsSlot.constraints.equipmentType
      : [lightsSlot.constraints.equipmentType]
    : null;

  return {
    id: "motion-light",
    name: "Motion Light",
    description:
      "Turns on lights when motion is detected, turns off after a timeout with no motion. Supports lux threshold, failsafe max-on duration, and button override.",

    slots: [
      ...baseSlots(),
      lightsSlot,
      ...commonTrailingSlots(),
    ],

    i18n: {
      fr: {
        name: "Lumière sur mouvement",
        description:
          "Allume les lumières quand un mouvement est détecté, éteint après un délai sans mouvement. Supporte un seuil de luminosité optionnel et une durée max d'allumage.",
        slots: {
          zone: { name: "Zone", description: "Zone à surveiller" },
          lights: {
            name: "Lumières",
            description: "Lumières à contrôler (doivent appartenir à la zone)",
          },
          timeout: { name: "Délai", description: "Délai sans mouvement avant extinction" },
          luxThreshold: {
            name: "Seuil lux (max)",
            description: "Au-dessus de ce seuil, les lumières ne s'allument pas",
          },
          maxOnDuration: {
            name: "Extinction auto (sécurité)",
            description: "Coupe les lumières après cette durée même avec mouvement — anti-oubli",
          },
          buttons: {
            name: "Interrupteurs",
            description: "Interrupteurs physiques pour allumer/éteindre manuellement",
          },
          disableWhenDaylight: {
            name: "Inactif le jour",
            description: "Ne pas allumer pendant la journée (basé sur lever/coucher du soleil)",
          },
        },
      },
    },

    // ============================================================
    // Validation
    // ============================================================

    validate(params: Record<string, unknown>, ctx: RecipeContext): void {
      const { zone, timeout, luxThreshold, maxOnDuration } = params;

      // Normalize lights (backward compat: single light -> lights array)
      const lightIds = normalizeLights(params);

      // Validate zone exists
      if (!zone || typeof zone !== "string") {
        throw new Error("Zone parameter is required");
      }
      const zoneObj = ctx.zoneManager.getById(zone);
      if (!zoneObj) {
        throw new Error(`Zone not found: ${zone}`);
      }
      const zoneData = ctx.zoneAggregator.getByZoneId(zone);
      if (zoneData && zoneData.motionSensors === 0) {
        ctx.log("Zone has no motion sensors — recipe will never trigger", "warn");
      }

      // Validate lights
      if (lightIds.length === 0) {
        throw new Error("At least one light is required");
      }
      for (const lightId of lightIds) {
        const equipment = ctx.equipmentManager.getByIdWithDetails(lightId);
        if (!equipment) {
          throw new Error(`Light equipment not found: ${lightId}`);
        }
        if (allowedTypes && !allowedTypes.includes(equipment.type)) {
          throw new Error(
            `Light "${equipment.name}" is type "${equipment.type}" but this recipe requires ${allowedTypes.join(" or ")}`,
          );
        }
        if (equipment.zoneId !== zone) {
          throw new Error(`Light "${equipment.name}" does not belong to the selected zone`);
        }
        const hasStateOrder = equipment.orderBindings.some((ob) => ob.alias === "state");
        if (!hasStateOrder) {
          throw new Error(`Light "${equipment.name}" has no "state" order binding`);
        }
      }

      // Validate timeout
      const timeoutValue = timeout || "10m";
      ctx.helpers.parseDuration(timeoutValue);

      // Validate luxThreshold
      if (luxThreshold !== undefined && luxThreshold !== null) {
        const lux = Number(luxThreshold);
        if (isNaN(lux) || lux < 0) {
          throw new Error("luxThreshold must be a non-negative number");
        }
      }

      // Validate maxOnDuration
      if (maxOnDuration !== undefined && maxOnDuration !== null && maxOnDuration !== "") {
        ctx.helpers.parseDuration(maxOnDuration);
      }

      // Validate buttons (optional)
      const { buttons } = params;
      if (buttons !== undefined && buttons !== null) {
        const buttonIds = Array.isArray(buttons)
          ? buttons.filter((id): id is string => typeof id === "string")
          : [];
        for (const buttonId of buttonIds) {
          const equipment = ctx.equipmentManager.getByIdWithDetails(buttonId);
          if (!equipment) {
            throw new Error(`Button equipment not found: ${buttonId}`);
          }
          const hasActionData = equipment.dataBindings.some((db) => db.alias === "action");
          if (!hasActionData) {
            throw new Error(`Button "${equipment.name}" has no "action" data binding`);
          }
        }
      }
    },

    // ============================================================
    // Create Instance
    // ============================================================

    createInstance(params: Record<string, unknown>, ctx: RecipeContext) {
      // -- Parse params --
      const zoneId = params.zone as string;
      const lightIds = normalizeLights(params);
      const timeoutMs = ctx.helpers.parseDuration(params.timeout || "10m");
      const luxThreshold =
        params.luxThreshold !== undefined && params.luxThreshold !== null
          ? Number(params.luxThreshold)
          : null;
      const maxOnDurationMs =
        params.maxOnDuration !== undefined &&
        params.maxOnDuration !== null &&
        params.maxOnDuration !== ""
          ? ctx.helpers.parseDuration(params.maxOnDuration)
          : null;
      const buttonIds = Array.isArray(params.buttons)
        ? params.buttons.filter((id): id is string => typeof id === "string")
        : [];
      const disableWhenDaylight = params.disableWhenDaylight === true;

      // -- State --
      let offTimer: ReturnType<typeof setTimeout> | null = null;
      let failsafeTimer: ReturnType<typeof setTimeout> | null = null;
      const unsubs: (() => void)[] = [];
      let overrideMode = false;
      let lightsOnByRecipe = ctx.helpers.isAnyLightOn(lightIds, ctx);
      /** Grace period: ignore light-off echoes for 5s after the recipe itself sends a turnOff */
      let turnOffGraceUntil = 0;
      /** Defence flag: set by stop(), checked by all event handlers to prevent orphaned execution */
      let stopped = false;

      // Clear any stale state from previous run
      ctx.state.delete("overrideMode");

      // ============================================================
      // Lux threshold checks
      // ============================================================

      function isTooBright(luminosity: number | null): boolean {
        if (luxThreshold === null) return false;
        if (luminosity === null) return false;
        return luminosity > luxThreshold;
      }

      function isBrightEnoughToTurnOff(luminosity: number | null): boolean {
        if (luxThreshold === null) return false;
        if (luminosity === null) return false;
        return luminosity > luxThreshold * (1 + LUX_HYSTERESIS_FACTOR);
      }

      // ============================================================
      // Daylight check
      // ============================================================

      function isDaytime(): boolean {
        if (!disableWhenDaylight) return false;
        const rootData = ctx.zoneAggregator.getByZoneId(ROOT_ZONE_ID);
        // null isDaylight (no coordinates configured) -> treated as night -> recipe functions normally
        return rootData?.isDaylight === true;
      }

      // ============================================================
      // Motion state helper
      // ============================================================

      function hasMotion(): boolean {
        const zoneData = ctx.zoneAggregator.getByZoneId(zoneId);
        return zoneData?.motion ?? false;
      }

      // ============================================================
      // Timer state persistence
      // ============================================================

      function persistOffTimerState(): void {
        const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
        ctx.state.set("timerExpiresAt", expiresAt);
      }

      function clearOffTimerState(): void {
        ctx.state.delete("timerExpiresAt");
      }

      function persistFailsafeTimerState(): void {
        const expiresAt = new Date(Date.now() + maxOnDurationMs!).toISOString();
        ctx.state.set("failsafeExpiresAt", expiresAt);
      }

      function clearFailsafeTimerState(): void {
        ctx.state.delete("failsafeExpiresAt");
      }

      // ============================================================
      // Timer management
      // ============================================================

      function cancelOffTimer(): void {
        if (offTimer) {
          clearTimeout(offTimer);
          offTimer = null;
        }
      }

      function cancelFailsafeTimer(): void {
        if (failsafeTimer) {
          clearTimeout(failsafeTimer);
          failsafeTimer = null;
        }
      }

      // ============================================================
      // Override management
      // ============================================================

      function clearOverrideMode(): void {
        if (!overrideMode) return;
        overrideMode = false;
        ctx.state.delete("overrideMode");
      }

      // ============================================================
      // Actions
      // ============================================================

      function doTurnOn(): void {
        const errors = ctx.helpers.turnOnLights(lightIds, ctx);
        if (errors.length > 0) {
          ctx.log(`Error turning on some lights: ${errors.join("; ")}`, "error");
        }
        ctx.log(`Motion detected — ${lightIds.length} light(s) turned on`);
      }

      function turnOn(): void {
        lightsOnByRecipe = true;
        doTurnOn();
        startFailsafeTimer();
      }

      function turnOff(reason: string): void {
        lightsOnByRecipe = false;
        turnOffGraceUntil = Date.now() + TURN_OFF_GRACE_MS;
        const errors = ctx.helpers.turnOffLights(lightIds, ctx);
        if (errors.length > 0) {
          ctx.log(`Error turning off some lights: ${errors.join("; ")}`, "error");
        }
        ctx.log(reason);
        cancelFailsafeTimer();
        clearFailsafeTimerState();
        clearOverrideMode();
      }

      function turnOffFailsafe(): void {
        lightsOnByRecipe = false;
        turnOffGraceUntil = Date.now() + TURN_OFF_GRACE_MS;
        const errors = ctx.helpers.turnOffLights(lightIds, ctx);
        if (errors.length > 0) {
          ctx.log(`Error turning off some lights: ${errors.join("; ")}`, "error");
        }
        ctx.log(
          `Failsafe: lights forced off after ${ctx.helpers.formatDuration(maxOnDurationMs!)} max on duration`,
          "warn",
        );
      }

      // ============================================================
      // Failsafe timer
      // ============================================================

      function startFailsafeTimer(): void {
        if (maxOnDurationMs === null) return;
        if (failsafeTimer) return;

        failsafeTimer = setTimeout(() => {
          failsafeTimer = null;
          clearFailsafeTimerState();
          cancelOffTimer();
          clearOffTimerState();
          turnOffFailsafe();
        }, maxOnDurationMs);
        persistFailsafeTimerState();
      }

      function resetFailsafeTimer(): void {
        if (maxOnDurationMs === null) return;
        if (!failsafeTimer) return;
        cancelFailsafeTimer();
        failsafeTimer = setTimeout(() => {
          failsafeTimer = null;
          clearFailsafeTimerState();
          cancelOffTimer();
          clearOffTimerState();
          turnOffFailsafe();
        }, maxOnDurationMs);
        persistFailsafeTimerState();
      }

      // ============================================================
      // Off-timer management
      // ============================================================

      function startOffTimer(): void {
        cancelOffTimer();
        offTimer = setTimeout(() => {
          offTimer = null;
          clearOffTimerState();
          turnOff(`No motion for ${ctx.helpers.formatDuration(timeoutMs)} — lights turned off`);
        }, timeoutMs);
        persistOffTimerState();
      }

      function startOffTimerForOverrideClear(): void {
        cancelOffTimer();
        offTimer = setTimeout(() => {
          offTimer = null;
          clearOffTimerState();
          if (ctx.helpers.isAnyLightOn(lightIds, ctx)) {
            lightsOnByRecipe = false;
            turnOffGraceUntil = Date.now() + TURN_OFF_GRACE_MS;
            ctx.helpers.turnOffLights(lightIds, ctx);
          }
          clearOverrideMode();
          cancelFailsafeTimer();
          clearFailsafeTimerState();
          ctx.log(
            `No motion for ${ctx.helpers.formatDuration(timeoutMs)} — override cleared, lights off`,
          );
        }, timeoutMs);
        persistOffTimerState();
      }

      // ============================================================
      // Event handlers
      // ============================================================

      function onZoneChanged(motion: boolean, luminosity: number | null): void {
        if (stopped) return;

        // Override mode: recipe is suspended, only track room vacancy
        if (overrideMode) {
          if (motion) {
            cancelOffTimer();
            clearOffTimerState();
            resetFailsafeTimer();
            ctx.log("Motion detected but override mode active — ignoring");
          } else {
            startOffTimerForOverrideClear();
          }
          return;
        }

        // Normal (auto) mode
        const lightsOn = ctx.helpers.isAnyLightOn(lightIds, ctx);

        // Dynamic lux check: turn off if luminosity rose above threshold (with hysteresis)
        if (lightsOn && isBrightEnoughToTurnOff(luminosity)) {
          if (!lightsOnByRecipe) {
            // Grace period: recipe recently sent OFF — this ON echo is a stale
            // MQTT round-trip from a previous turnOn, not a manual action.
            if (Date.now() < turnOffGraceUntil) return;
            overrideMode = true;
            ctx.state.set("overrideMode", true);
            startFailsafeTimer();
            ctx.log("Light turned on manually above lux threshold — entering override mode");
            return;
          }
          cancelOffTimer();
          clearOffTimerState();
          turnOff("Luminosity above threshold — lights turned off");
          return;
        }

        if (motion && !lightsOn) {
          // Grace: a zone.data.changed (e.g. luminosity drop after we just sent
          // OFF) can fire while motion is still cached as true. Without this
          // guard the failsafe turn-off is immediately undone by the next
          // motion-true event arriving on the OFF echo.
          if (Date.now() < turnOffGraceUntil) return;

          // If recipe had turned lights on but they're now off -> manual turn-off
          if (lightsOnByRecipe) {
            lightsOnByRecipe = false;
            // Manual turnoff while motion active -> override
            overrideMode = true;
            ctx.state.set("overrideMode", true);
            startOffTimerForOverrideClear();
            ctx.log("Light turned off manually while motion active — entering override mode");
            return;
          }
          // Check lux threshold before turning on
          if (isTooBright(luminosity)) {
            ctx.log(
              `Motion detected but luminosity ${luminosity} exceeds threshold ${luxThreshold} — not turning on`,
            );
            return;
          }
          // Check daylight before turning on
          if (isDaytime()) {
            ctx.log("Motion detected but daytime — not turning on");
            return;
          }
          turnOn();
        } else if (motion && lightsOn) {
          // Reset off-timer and failsafe on every motion impulse
          cancelOffTimer();
          clearOffTimerState();
          resetFailsafeTimer();
        } else if (!motion && lightsOn) {
          startOffTimer();
        }
        // !motion && !lightsOn -> nothing to do
      }

      function onLightChanged(value: unknown): void {
        if (stopped) return;
        if (overrideMode) return;

        const lightOn = value === true || String(value).toUpperCase() === "ON";
        const motion = hasMotion();

        if (lightOn && !motion) {
          startOffTimer();
          startFailsafeTimer();
          ctx.log(`Light turned on externally — turning off in ${ctx.helpers.formatDuration(timeoutMs)}`);
        } else if (lightOn && motion) {
          cancelOffTimer();
          clearOffTimerState();
        } else if (!lightOn) {
          // Grace: this OFF event is the echo of an order we just sent. Don't
          // treat it as a manual/external action — that would (a) miss the
          // override-mode case and (b) wipe a freshly armed failsafe if a
          // re-light was triggered between our OFF and its echo.
          if (Date.now() < turnOffGraceUntil) return;

          // Manual turn-off while motion active -> enter override mode
          // Must check BEFORE resetting lightsOnByRecipe
          if (lightsOnByRecipe && motion) {
            lightsOnByRecipe = false;
            overrideMode = true;
            ctx.state.set("overrideMode", true);
            cancelOffTimer();
            cancelFailsafeTimer();
            clearOffTimerState();
            clearFailsafeTimerState();
            startOffTimerForOverrideClear();
            ctx.log("Light turned off manually while motion active — entering override mode");
            return;
          }
          lightsOnByRecipe = false;
          if (offTimer || failsafeTimer) {
            cancelOffTimer();
            cancelFailsafeTimer();
            clearOffTimerState();
            clearFailsafeTimerState();
            ctx.log("Light turned off externally — timers cancelled");
          }
        }
      }

      // ============================================================
      // Button handler
      // ============================================================

      function onButtonAction(): void {
        if (stopped) return;
        if (ctx.helpers.isAnyLightOn(lightIds, ctx)) {
          lightsOnByRecipe = false;
          turnOffGraceUntil = Date.now() + TURN_OFF_GRACE_MS;
          const errors = ctx.helpers.turnOffLights(lightIds, ctx);
          if (errors.length > 0) {
            ctx.log(`Error turning off some lights: ${errors.join("; ")}`, "error");
          }
          cancelOffTimer();
          clearOffTimerState();
          cancelFailsafeTimer();
          clearFailsafeTimerState();

          overrideMode = true;
          ctx.state.set("overrideMode", true);
          ctx.log("Button pressed — lights off, entering override mode");

          startOffTimerForOverrideClear();
        } else {
          clearOverrideMode();
          turnOn();
        }
      }

      // ============================================================
      // Initial sync
      // ============================================================

      function syncLightsOnStart(): void {
        const zoneData = ctx.zoneAggregator.getByZoneId(zoneId);
        const motion = zoneData?.motion ?? false;
        const luminosity = zoneData?.luminosity ?? null;

        if (motion && !isTooBright(luminosity) && !isDaytime()) {
          turnOn();
        } else {
          const reason = isDaytime()
            ? "Recipe activated — daytime, lights off"
            : motion
              ? "Recipe activated — luminosity above threshold, lights off"
              : "Recipe activated — no motion, lights off";
          turnOff(reason);
        }
      }

      // ============================================================
      // Subscribe to events
      // ============================================================

      // Listen to zone aggregation changes (for motion + luminosity)
      const unsubZone = ctx.eventBus.onType("zone.data.changed", (event) => {
        if (event.zoneId !== zoneId) return;
        const aggregatedData = event.aggregatedData as { motion: boolean; luminosity: number | null };
        onZoneChanged(aggregatedData.motion, aggregatedData.luminosity);
      });
      unsubs.push(unsubZone);

      // Listen to light state changes (for manual on/off)
      const unsubLight = ctx.eventBus.onType("equipment.data.changed", (event) => {
        if (!lightIds.includes(event.equipmentId as string)) return;
        if (event.alias !== "state") return;
        onLightChanged(event.value);
      });
      unsubs.push(unsubLight);

      // Listen to button actions (optional)
      if (buttonIds.length > 0) {
        const unsubButton = ctx.eventBus.onType("equipment.data.changed", (event) => {
          if (!buttonIds.includes(event.equipmentId as string)) return;
          if (event.alias !== "action") return;
          onButtonAction();
        });
        unsubs.push(unsubButton);
      }

      // Force consistent light state on activation
      syncLightsOnStart();
      // Reset grace — syncLightsOnStart's turnOff is not a "recipe action" that
      // should suppress manual-off override detection
      turnOffGraceUntil = 0;

      // ============================================================
      // Return instance handle
      // ============================================================

      return {
        stop() {
          stopped = true;
          cancelOffTimer();
          cancelFailsafeTimer();
          for (const unsub of unsubs) {
            unsub();
          }
          unsubs.length = 0;
          overrideMode = false;
          lightsOnByRecipe = false;
          turnOffGraceUntil = 0;
          ctx.state.delete("overrideMode");
          ctx.state.delete("timerExpiresAt");
          ctx.state.delete("failsafeExpiresAt");
        },
      };
    },
  };
}
