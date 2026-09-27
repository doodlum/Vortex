/**
 * Design comparison: the ids of the menu Deploy status row variations offered. Stable:
 * 1 to 5 named earlier designs, 8 the Progress line row and 9 the Chip row, all removed,
 * so any of those reads as the first variation. The first is the default.
 */
export const DEPLOY_DESIGN_IDS = [6, 7, 10, 11] as const;

/**
 * The variation a stored `deployButtonStyle` names: the default when it is unset or names
 * a design that was removed. Reading goes through this because verifiers only check a
 * hydrated value's type, and a removed design's id is still a number.
 */
export const resolveDeployDesign = (stored: number | undefined): number =>
  DEPLOY_DESIGN_IDS.includes(stored as (typeof DEPLOY_DESIGN_IDS)[number])
    ? (stored as number)
    : DEPLOY_DESIGN_IDS[0];

/**
 * Design comparison: how Play is held back while a deployment is pending, independent of
 * the row. 1 Disabled, 2 Locked by the row, 3 Deploy first. The first is the default.
 */
export const PLAY_GATE_IDS = [1, 2, 3] as const;

/** The gate a stored `playWhilePending` names, or the default. */
export const resolvePlayGate = (stored: number | undefined): number =>
  PLAY_GATE_IDS.includes(stored as (typeof PLAY_GATE_IDS)[number])
    ? (stored as number)
    : PLAY_GATE_IDS[0];
