import { Transition } from "@headlessui/react";
import React, { useEffect, useRef } from "react";

import { useWindowContext } from "@/contexts";
import { joinClasses } from "@/ui/utils/joinClasses";

import { useSpineContext } from "../Spine/SpineContext";
import { DeployControl } from "./deploy/DeployControl";
import { ToolButton } from "./ToolButton";
import { useToolsContext } from "./ToolsContext";
interface IToolsSectionProps {
  /** How tall the section stands over the menu's pages, which have to leave it room. */
  onHeightChange?: (height: number) => void;
}

export const ToolsSection = ({ onHeightChange }: IToolsSectionProps) => {
  const { menuIsCollapsed } = useWindowContext();
  const ref = useRef<HTMLDivElement>(null);
  const { selection } = useSpineContext();
  const {
    gameId,
    gameName,
    visibleTools,
    primaryStarter,
    primaryToolId,
    isPrimaryRunning,
    exclusiveRunning,
    isToolRunning,
    startTool,
    handlePlay,
  } = useToolsContext();

  const shown = gameId !== undefined && selection.type === "game";

  // The Deploy control's designs differ in height, so the room the pages leave is
  // measured rather than counted.
  useEffect(() => {
    const element = ref.current;
    if (!shown || element === null || typeof ResizeObserver === "undefined") {
      onHeightChange?.(0);
      return;
    }
    const observer = new ResizeObserver(() => onHeightChange?.(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange, shown]);

  if (!shown) {
    return null;
  }

  return (
    <div
      ref={ref}
      className={joinClasses([
        "absolute bottom-3 left-3 z-2 flex flex-col items-center gap-y-3 transition-[left,width]",
        menuIsCollapsed ? "w-10" : "w-49",
      ])}
    >
      {!!visibleTools.length && (
        <Transition
          appear
          show
          as="div"
          className={joinClasses([
            "flex items-center gap-1 border-b border-stroke-weak pb-3",
            menuIsCollapsed ? "w-10 flex-wrap justify-center" : "w-full flex-wrap-reverse",
          ])}
          data-testid="menu-tools"
          enter="transition-[translate,opacity] delay-150 duration-200 reduce-motion:delay-0"
          enterFrom="translate-y-6 opacity-0 reduce-motion:translate-y-0 reduce-motion:opacity-100"
          enterTo="translate-y-0 opacity-100"
          key={menuIsCollapsed ? "collapsed" : "expanded"}
        >
          {visibleTools.map((starter) => (
            <ToolButton
              isRunning={isToolRunning(starter.exePath)}
              key={starter.id}
              starter={starter}
              onClick={() => startTool(starter)}
            />
          ))}
        </Transition>
      )}

      <DeployControl
        play={{
          disabled: exclusiveRunning || isPrimaryRunning || !primaryStarter,
          gameName,
          isCollapsed: menuIsCollapsed,
          isPrimaryRunning,
          primaryStarter: primaryToolId ? primaryStarter : undefined,
          onClick: handlePlay,
        }}
      />
    </div>
  );
};
