import type { ILootReference } from "../types/ILOOTList";

export type LootReference = string | ILootReference;

export function referenceName(reference: LootReference): string {
  return typeof reference === "string" ? reference : reference.name;
}

export function referenceKey(reference: LootReference): string {
  return JSON.stringify([
    referenceName(reference).toLowerCase(),
    typeof reference === "string" ? "" : (reference.condition ?? ""),
  ]);
}

export function referencesMatch(left: LootReference, right: LootReference): boolean {
  return referenceKey(left) === referenceKey(right);
}
