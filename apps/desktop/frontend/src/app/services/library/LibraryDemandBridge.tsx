import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useTheaterContext } from "../../providers/TheaterProvider";
import { useScreenshot } from "../../hooks/screenshot";

export function LibraryDemandBridge() {
  const { library } = useTheaterContext(), location = useLocation(), { capturing } = useScreenshot();
  useEffect(() => { library.setViewerVisible(location.pathname === "/app/analyzer"); }, [library, location.pathname]);
  useEffect(() => capturing ? library.acquireForeground() : undefined, [library, capturing]);
  return null;
}
