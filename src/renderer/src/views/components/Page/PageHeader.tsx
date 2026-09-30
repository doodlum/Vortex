import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { type IPictogramName, Pictogram } from "@/ui/components/pictogram/Pictogram";
import { Typography } from "@/ui/components/typography/Typography";
import { joinClasses } from "@/ui/utils/joinClasses";
import type { XOr } from "@/ui/utils/types";

import { usePage } from "./Page.context";
import { PageContent } from "./PageContent";

export type IPageHeaderProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  isFullWidth?: boolean;
  children?: ReactNode | ((compact: boolean) => ReactNode);
  pictogramName?: IPictogramName;
  subtitle?: string;
} & XOr<{ title: string }, { customTitle: ReactNode | ((compact: boolean) => ReactNode) }>;

/** Panel chrome can stay pinned to the header corner without changing page APIs. */
export const PageHeaderActionsContext = createContext<ReactNode>(null);

/**
 * Full-bleed header for a non-scrolling `Page`. The bar itself spans the full
 * width (so its background/shadow reach the viewport edges) and stays pinned
 * above the `PageScroll` sibling, while its content is centred and capped at
 * `max-w-8xl` so it lines up with the scrolled content. It trades its hairline
 * for a shadow once that sibling is scrolled — unless `isFullWidth`, where
 * content reaches the bar itself, so the hairline stays and the shadow is
 * skipped.
 *
 * Scrolling also shrinks the header to its compact form, which the
 * always-compact-headers setting can instead pin on; pass a render-prop child
 * to follow that state too.
 *
 * Pass `title` for the common heading, or `customTitle` when the title needs
 * more than a string (e.g. a badge alongside it); `subtitle` renders below
 * either. `title` goes subdued once compact — `customTitle` takes a
 * render-prop so it can match.
 */
export const PageHeader = ({
  children,
  className,
  isFullWidth = false,
  pictogramName,
  title,
  customTitle,
  subtitle,
  ...rest
}: IPageHeaderProps) => {
  const { compact, scrolled } = usePage();
  const panelActions = useContext(PageHeaderActionsContext);
  const pageActions = typeof children === "function" ? children(compact) : children;
  const hasPageActions = !!pageActions;
  const hasPanelActions = !!panelActions;
  const headerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const panelActionsRef = useRef<HTMLDivElement>(null);
  const [wrappedToolbarShift, setWrappedToolbarShift] = useState(0);
  const toolbarShiftRef = useRef(0);

  useLayoutEffect(() => {
    if (!hasPageActions || !hasPanelActions) return;
    const header = headerRef.current;
    const toolbar = toolbarRef.current;
    const panelControls = panelActionsRef.current;
    if (!header || !toolbar || !panelControls) return;

    const measure = () => {
      const toolbarBounds = toolbar.getBoundingClientRect();
      const panelBounds = panelControls.getBoundingClientRect();
      if (!toolbarBounds.height || !panelBounds.height) return;
      const shareRow = Math.abs(toolbarBounds.top - panelBounds.top) < 2;
      // The close button occupies the title row. A wrapped toolbar can use the
      // normal content gutter without changing the flex line break decision.
      const contentRight = toolbar.parentElement?.parentElement?.getBoundingClientRect().right;
      const shift =
        shareRow || contentRight === undefined
          ? 0
          : Math.max(
              0,
              Math.min(32, contentRight - 24 - (toolbarBounds.right - toolbarShiftRef.current)),
            );
      toolbarShiftRef.current = shift;
      setWrappedToolbarShift(shift);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(header);
    observer?.observe(toolbar);
    observer?.observe(panelControls);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [hasPageActions, hasPanelActions, compact]);

  return (
    <div
      ref={headerRef}
      data-page-header=""
      className={joinClasses(["relative z-10 w-full py-3 pb-3", className], {
        "border-b border-stroke-weak": !scrolled || isFullWidth,
        "shadow-md": scrolled && !isFullWidth,
      })}
      {...rest}
    >
      <PageContent
        className={joinClasses(["flex items-start gap-x-2 pl-6", panelActions ? "pr-14" : "pr-6"])}
        isFullWidth={isFullWidth}
      >
        {!!pictogramName && (
          <Pictogram
            className={joinClasses(["transition-[width,height]", compact ? "size-7" : "size-14"])}
            name={pictogramName}
            size="none"
          />
        )}

        <div className="flex min-w-0 grow flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-16 grow overflow-hidden">
            {(typeof customTitle === "function" ? customTitle(compact) : customTitle) ?? (
              <Typography
                appearance={compact ? "subdued" : "moderate"}
                as="h2"
                className="truncate transition-colors"
                typographyType="heading-xs"
              >
                {title}
              </Typography>
            )}
            {!!subtitle && (
              <Typography
                appearance="subdued"
                className={joinClasses("truncate", { hidden: compact })}
              >
                {subtitle}
              </Typography>
            )}
          </div>
          {pageActions && (
            <div
              ref={toolbarRef}
              data-page-header-toolbar=""
              className="ml-auto flex shrink-0 items-center gap-3"
              style={
                hasPanelActions && wrappedToolbarShift
                  ? { transform: `translateX(${wrappedToolbarShift}px)` }
                  : undefined
              }
            >
              {pageActions}
            </div>
          )}
        </div>
      </PageContent>
      {panelActions && (
        <div
          ref={panelActionsRef}
          data-panel-header-actions=""
          className="absolute top-3 right-3 flex items-center"
        >
          {panelActions}
        </div>
      )}
    </div>
  );
};

PageHeader.displayName = "PageHeader";
