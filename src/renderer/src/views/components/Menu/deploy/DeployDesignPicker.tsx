import React from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";

import {
  setDeployButtonStyle,
  setPlayWhilePending,
} from "@/extensions/settings_interface/actions/interface";
import type { IState } from "@/types/IState";
import { Picker } from "@/ui/components/picker/Picker";
import { Typography } from "@/ui/components/typography/Typography";

import { DEPLOY_DESIGNS, designSelector, playGateSelector } from "./DeployControl";
import { PLAY_GATES } from "./playGate";

/**
 * Design comparison, for Settings > Interface: picks the menu's Deploy control design,
 * which changes at once. To be removed with the designs not chosen.
 */
export const DeployDesignPicker = () => {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const value = useSelector(designSelector);
  const gateValue = useSelector(playGateSelector);
  const modern = useSelector((state: IState) => state.settings.window.useModernLayout ?? true);

  // The classic layout has no menu to put Deploy in.
  if (!modern) {
    return null;
  }

  return (
    <div className="flex flex-col items-start gap-y-2" data-testid="deploy-design-picker">
      <Typography as="span">{t("Deploy button style")}</Typography>

      <Picker<number>
        options={DEPLOY_DESIGNS.map((design) => ({
          label: t(design.name),
          value: design.id,
        }))}
        placement="left"
        value={value}
        onChange={(style) => dispatch(setDeployButtonStyle(style))}
      />

      <Typography appearance="subdued" typographyType="body-sm">
        {t("Design comparison: how Deploy shows above Play in the menu.")}
      </Typography>

      <Typography as="span">{t("Play while a deploy is pending")}</Typography>

      <Picker<number>
        options={PLAY_GATES.map((gate) => ({ label: t(gate.name), value: gate.id }))}
        placement="left"
        value={gateValue}
        onChange={(style) => dispatch(setPlayWhilePending(style))}
      />

      <Typography appearance="subdued" typographyType="body-sm">
        {t("Design comparison: how Play is held back until pending changes are deployed.")}
      </Typography>
    </div>
  );
};
