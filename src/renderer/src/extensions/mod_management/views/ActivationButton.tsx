import React from "react";
import { useTranslation } from "react-i18next";

import ToolbarIcon from "@/controls/ToolbarIcon";

import { useDeployMods } from "../hooks/useDeployMods.hook";

/** The classic toolbar uses the same deployment outcomes as the modern controls. */
export default function ActivationButton() {
  const { t } = useTranslation();
  const { needToDeploy, isDeploying, deploy } = useDeployMods();
  return (
    <ToolbarIcon
      className={needToDeploy ? "toolbar-flash-button" : undefined}
      disabled={isDeploying}
      icon="deploy"
      id="deploy-mods"
      text={t("Deploy Mods")}
      onClick={deploy}
    />
  );
}
