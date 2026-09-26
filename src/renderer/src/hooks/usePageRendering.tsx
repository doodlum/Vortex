import React, { useCallback, useEffect, useReducer } from "react";
import { useSelector } from "react-redux";

import type { IMainPage } from "../types/IMainPage";
import {
  mainPage as mainPageSelector,
  secondaryPage as secondaryPageSelector,
} from "../util/selectors";
import { MainPageContainer } from "../views/MainPageContainer";

export const usePageRendering = () => {
  const mainPage = useSelector(mainPageSelector);
  const secondaryPage = useSelector(secondaryPageSelector);

  const [loadedPages, setLoadedPages] = useReducer(
    (prev: string[], pageId: string) => (prev.includes(pageId) ? prev : [...prev, pageId]),
    mainPage ? [mainPage] : [],
  );

  // A page can be opened in either pane before it has ever been visited.
  useEffect(() => {
    if (mainPage) {
      setLoadedPages(mainPage);
    }
    if (secondaryPage) {
      setLoadedPages(secondaryPage);
    }
  }, [mainPage, secondaryPage]);

  const renderPage = useCallback(
    (page: IMainPage) => {
      if (loadedPages.indexOf(page.id) === -1) {
        return null;
      }

      const active = [mainPage, secondaryPage].indexOf(page.id) !== -1;

      return (
        <MainPageContainer
          active={active}
          key={page.id}
          page={page}
          secondary={secondaryPage === page.id}
        />
      );
    },
    [loadedPages, mainPage, secondaryPage],
  );

  return {
    mainPage,
    secondaryPage,
    loadedPages,
    setLoadedPages,
    renderPage,
  };
};
