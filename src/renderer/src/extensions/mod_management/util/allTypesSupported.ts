import * as _ from "lodash";

import { log } from "../../../util/log";
import { getSafe } from "../../../util/storeHelper";
import type { IModType } from "../../gamemode_management/types/IModType";
import { getModType } from "../../gamemode_management/util/modTypeExtensions";
import type { IDeploymentMethod, IUnavailableReason } from "../types/IDeploymentMethod";
import { getAllActivators } from "./deploymentMethods";

type Support = { errors: IUnavailableReason[]; warnings: IUnavailableReason[] };

function typesSupported(
  activator: IDeploymentMethod,
  state: any,
  gameId: string,
  types: string[],
): Support {
  return types.reduce(
    (prev, type) => {
      const reason = activator.isSupported(state, gameId, type);
      if (reason !== undefined) {
        if (!_.isFunction(reason.description)) {
          log("error", "deployment unavailable with no description", {
            gameId,
            method: activator.id,
            reason: JSON.stringify(reason),
          });
          reason.description = () =>
            "<Missing description, please report this and include a log file>";
        }
        const typeInfo: IModType = getModType(type);
        const { deploymentEssential } = getSafe(typeInfo, ["options"], {
          deploymentEssential: true,
        });
        prev[deploymentEssential === false ? "warnings" : "errors"].push(reason);
      }
      return prev;
    },
    { errors: [], warnings: [] },
  );
}

/** The supported method that replaces `activator` for this game, if any (`supersedes`). */
export function supersedingMethod(
  activator: IDeploymentMethod,
  state: any,
  gameId: string,
  types: string[],
): IDeploymentMethod | undefined {
  return getAllActivators().find(
    (other) =>
      other.id !== activator.id &&
      (other.supersedes ?? []).includes(activator.id) &&
      typesSupported(other, state, gameId, types).errors.length === 0,
  );
}

function allTypesSupported(
  activator: IDeploymentMethod,
  state: any,
  gameId: string,
  types: string[],
): Support {
  if (activator === undefined) {
    return {
      errors: [{ description: (t) => t("No deployment method selected") }],
      warnings: [],
    };
  }
  const successor = supersedingMethod(activator, state, gameId, types);
  if (successor !== undefined) {
    return {
      errors: [
        {
          description: (t) =>
            t("Replaced by {{method}} for this game.", { replace: { method: successor.name } }),
        },
      ],
      warnings: [],
    };
  }
  return typesSupported(activator, state, gameId, types);
}

export default allTypesSupported;
