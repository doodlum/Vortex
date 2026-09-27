/**
 * Design comparison: the ids of the menu Deploy status row variations offered. Stable, and
 * new: 1 to 5 named the earlier designs (the NMA panel, split, status row, rocket, merged
 * into Play), all removed, so a stored 1 to 5 reads as the first variation. The first is
 * the default.
 */
export const DEPLOY_DESIGN_IDS = [6, 7, 8, 9, 10] as const;

/**
 * The variation a stored `deployButtonStyle` names: the default when it is unset or names
 * a design that was removed. Reading goes through this because verifiers only check a
 * hydrated value's type, and a removed design's id is still a number.
 */
export const resolveDeployDesign = (stored: number | undefined): number =>
  DEPLOY_DESIGN_IDS.includes(stored as (typeof DEPLOY_DESIGN_IDS)[number])
    ? (stored as number)
    : DEPLOY_DESIGN_IDS[0];
