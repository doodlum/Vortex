import React, { type FC } from "react";

import { useSwitchingProfile } from "../../hooks";
import { Header } from "../components/Header/Header";
import { Menu } from "../components/Menu/Menu";
import { PanelProvider } from "../components/panels/PanelContext";
import { PanelWorkspace } from "../components/panels/PanelWorkspace";
import { Spine } from "../components/Spine/Spine";
import { SpineProvider } from "../components/Spine/SpineContext";
import { DialogLayer } from "./DialogLayer";
import { LayoutContainer } from "./LayoutContainer";
import { ProfileSwitcher } from "./ProfileSwitcher";
import { ToastContainer } from "./ToastContainer";
import { UIBlocker } from "./UIBlocker";

export const ModernLayout: FC<React.PropsWithChildren<unknown>> = () => {
  const switchingProfile = useSwitchingProfile();

  return (
    <SpineProvider>
      <PanelProvider>
        <LayoutContainer className="flex h-full bg-surface-base">
          <Spine />

          <div className="flex min-w-0 grow flex-col">
            <Header />

            <div className="flex min-h-0 grow">
              {switchingProfile ? (
                <ProfileSwitcher />
              ) : (
                <>
                  <Menu />

                  <PanelWorkspace />
                </>
              )}

              <DialogLayer />

              <ToastContainer />
            </div>
          </div>
        </LayoutContainer>

        <UIBlocker />
      </PanelProvider>
    </SpineProvider>
  );
};
