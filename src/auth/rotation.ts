import type { AuthConfig } from "./config.js";
import type { AuthSlotRecord } from "./storage.js";

export interface RotationPlan {
  mode: AuthConfig["rotation"];
  order: string[];
}

export function buildRotationPlan(
  slots: AuthSlotRecord[],
  config: Pick<AuthConfig, "rotation" | "priority">,
  currentSlot?: string,
): RotationPlan {
  const available = slots.map((slot) => slot.slot).sort((a, b) => a.localeCompare(b));
  if (config.rotation === "manual") return { mode: "manual", order: currentSlot ? [currentSlot] : available.slice(0, 1) };
  if (config.rotation === "priority") {
    const priority = config.priority.filter((slot) => available.includes(slot));
    const rest = available.filter((slot) => !priority.includes(slot));
    return { mode: "priority", order: [...priority, ...rest] };
  }
  if (!currentSlot || !available.includes(currentSlot)) return { mode: "round-robin", order: available };
  const index = available.indexOf(currentSlot);
  return { mode: "round-robin", order: [...available.slice(index), ...available.slice(0, index)] };
}

export function nextSlotAfter(order: string[], current: string | undefined, exhausted: Set<string>): string | undefined {
  if (order.length === 0) return undefined;
  const start = current && order.includes(current) ? order.indexOf(current) + 1 : 0;
  for (let offset = 0; offset < order.length; offset++) {
    const slot = order[(start + offset) % order.length];
    if (!exhausted.has(slot)) return slot;
  }
  return undefined;
}
