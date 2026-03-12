import { useCallback, useRef, useState } from "react";
import { PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "../constants";

export function usePanelResize() {
  const [width, setWidth] = useState(PANEL_DEFAULT_WIDTH);
  // Mirror of width in a ref so onMouseDown can read the current value at drag-start
  // without needing width in its dependency array (which would recreate the handler
  // on every drag frame as width state updates).
  const widthRef = useRef(PANEL_DEFAULT_WIDTH);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = widthRef.current;
    e.preventDefault();

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX.current - e.clientX;
      const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, startWidth.current + delta));
      widthRef.current = next;
      setWidth(next);
    };
    const onMouseUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  return { width, onMouseDown };
}
