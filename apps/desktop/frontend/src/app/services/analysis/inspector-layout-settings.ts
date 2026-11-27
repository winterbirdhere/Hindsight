import { JSONSchemaType } from "ajv";
import { injectable } from "inversify";
import { PersistentService } from "../core/service";

export interface InspectorLayoutSettings {
  /** Whether the inspector column is shown; the narrow-window drawer keeps its own session state. */
  visible: boolean;
  /** Width in CSS px as chosen by the user; the effective width is `clampInspectorWidth(width, windowWidth)`. */
  width: number;
}

export const DEFAULT_INSPECTOR_LAYOUT: InspectorLayoutSettings = Object.freeze({ visible: true, width: 260 });

/** 240 px … min(440 px, window width − 480 px) (user feedback; spec §5.9 D had 280…640). `minStage` is the stage width kept beside the inspector. */
export const INSPECTOR_WIDTH_LIMITS = { min: 240, max: 440, minStage: 480 } as const;

export function inspectorWidthBounds(windowWidth: number): { min: number; max: number } {
  const { min, max, minStage } = INSPECTOR_WIDTH_LIMITS;
  const room = Number.isFinite(windowWidth) ? windowWidth - minStage : 0;
  // Never below the minimum, even in a window too small for both.
  return { min, max: Math.max(min, Math.min(max, room)) };
}

/** A request that is not a finite number falls back to the default width before it is limited. */
export function clampInspectorWidth(requested: number, windowWidth: number): number {
  const { min, max } = inspectorWidthBounds(windowWidth);
  const wanted = typeof requested === "number" && Number.isFinite(requested) ? requested : DEFAULT_INSPECTOR_LAYOUT.width;
  return Math.min(max, Math.max(min, Math.round(wanted)));
}

/** Whatever the store holds (stale storage, a hand-edited value) becomes a safe pair; the width still needs clamping. */
export function sanitizeInspectorLayout(value: unknown): InspectorLayoutSettings {
  const stored = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    visible: typeof stored.visible === "boolean" ? stored.visible : DEFAULT_INSPECTOR_LAYOUT.visible,
    width: typeof stored.width === "number" && Number.isFinite(stored.width) ? stored.width : DEFAULT_INSPECTOR_LAYOUT.width,
  };
}

export const InspectorLayoutSettingsSchema: JSONSchemaType<InspectorLayoutSettings> = {
  type: "object",
  properties: {
    visible: { type: "boolean", default: DEFAULT_INSPECTOR_LAYOUT.visible },
    // No min/max here: a stored 5 should still keep the saved visibility; the consumer clamps it.
    width: { type: "number", default: DEFAULT_INSPECTOR_LAYOUT.width },
  },
  required: [],
};

@injectable()
export class InspectorLayoutSettingsStore extends PersistentService<InspectorLayoutSettings> {
  key = "inspector-layout";
  schema = InspectorLayoutSettingsSchema;

  getDefaultValue(): InspectorLayoutSettings {
    return DEFAULT_INSPECTOR_LAYOUT;
  }
}
