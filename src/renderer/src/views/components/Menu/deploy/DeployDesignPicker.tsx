import React from "react";
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from "react-redux";

import { setDeployButtonStyle } from "@/extensions/settings_interface/actions/interface";
import type { IState } from "@/types/IState";
import { Picker } from "@/ui/components/picker/Picker";
import { Typography } from "@/ui/components/typography/Typography";

import { DEFAULT_DEPLOY_DESIGN, DEPLOY_DESIGNS } from "./DeployControl";

const designSelector = (state: IState): number =>
  state.settings.interface.deployButtonStyle ?? DEFAULT_DEPLOY_DESIGN;

/**
 * Design comparison, for Settings > Interface: picks the menu's Deploy control design,
 * which changes at once. To be removed with the designs not chosen.
 */
export const DeployDesignPicker = () => {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const value = useSelector(designSelector);
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
          label: `${design.id}. ${t(design.name)}`,
          value: design.id,
        }))}
        placement="left"
        value={value}
        onChange={(style) => dispatch(setDeployButtonStyle(style))}
      />

      <Typography appearance="subdued" typographyType="body-sm">
        {t("Design comparison: how Deploy shows above Play in the menu.")}
      </Typography>
    </div>
  );
};
