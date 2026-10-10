import type { IMod } from "../types/IMod";

/**
 * A deterministic tie-break for the deployment sort. Without a rule between two mods, sortMods
 * keeps their input order, and that is the store's key order: the order the installs *started*.
 * During a collection install several members start at once, so which of two conflicting members
 * wins an unruled file conflict was a race.
 *
 * This puts the members of installed collections in the order their collection lists them, in the
 * positions members already hold; every other mod keeps its position. A member is matched to its
 * rule by the reference tag the install stamped on it. For a mod in several collections, the
 * collection with the lowest id decides.
 */
export function orderCollectionMembers(
  sortInput: IMod[],
  allMods: { [modId: string]: IMod },
): IMod[] {
  const collections = Object.keys(allMods)
    .filter((id) => allMods[id]?.type === "collection")
    .sort();
  if (collections.length === 0) {
    return sortInput;
  }
  // tag -> [collection index, rule index]
  const position = new Map<string, [number, number]>();
  collections.forEach((collectionId, collectionIdx) => {
    (allMods[collectionId].rules ?? []).forEach((rule, ruleIdx) => {
      const tag = rule.reference?.tag;
      if (tag !== undefined && !position.has(tag)) {
        position.set(tag, [collectionIdx, ruleIdx]);
      }
    });
  });

  const tagOf = (mod: IMod): string | undefined => mod.attributes?.referenceTag;
  const slots: number[] = [];
  sortInput.forEach((mod, idx) => {
    const tag = tagOf(mod);
    if (tag !== undefined && position.has(tag)) {
      slots.push(idx);
    }
  });
  if (slots.length < 2) {
    return sortInput;
  }
  const members = slots
    .map((idx) => sortInput[idx])
    .sort((lhs, rhs) => {
      const [lc, lr] = position.get(tagOf(lhs));
      const [rc, rr] = position.get(tagOf(rhs));
      return lc - rc || lr - rr;
    });
  const result = sortInput.slice();
  slots.forEach((idx, pos) => {
    result[idx] = members[pos];
  });
  return result;
}
