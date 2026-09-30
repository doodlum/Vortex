import React, { createContext, useContext } from "react";

export interface IPageHeaderContext {
  headerPortal: () => HTMLElement | null;
  page: string;
  active: boolean;
}

const defaultValue: IPageHeaderContext = {
  headerPortal: () => null,
  page: "",
  active: false,
};

export const PageHeaderContext = createContext<IPageHeaderContext>(defaultValue);

export const PageHeaderProvider = PageHeaderContext.Provider;
export const PageHeaderConsumer = PageHeaderContext.Consumer;

export const usePageHeaderContext = (): IPageHeaderContext => {
  return useContext(PageHeaderContext);
};
