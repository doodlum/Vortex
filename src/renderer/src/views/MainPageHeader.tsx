import React, { type FC, type ReactNode, useContext } from "react";
import { Portal } from "react-overlays";

import { PageHeaderContext } from "./MainPageContainer";

export interface IProps {
  children?: ReactNode;
}

export const MainPageHeader: FC<React.PropsWithChildren<IProps>> = ({ children }) => {
  const { headerPortal, active } = useContext(PageHeaderContext);

  if (!active || !headerPortal?.()) {
    return null;
  }
  return (
    <Portal container={headerPortal}>
      <div className="mainpage-header">{children}</div>
    </Portal>
  );
};

export default MainPageHeader;
