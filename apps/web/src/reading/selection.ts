/**
 * Keeps a mouse text selection on the page while the pointer is dragged past
 * the scrolling page, over the top bar or the footer.
 *
 * Browsers map a point outside the page to a position after the whole chapter
 * (the reader's bars follow it in the document), so the highlight jumped to
 * the end of the chapter and back as the pointer crossed the edge. While such
 * a drag lasts, the selection end is moved, once a frame and before paint, to
 * the line under the nearest point inside the page, keeping the place where
 * the drag began. The browser's own
 * scrolling during the drag still runs and the selection follows it.
 */
export function containSelection(viewport: HTMLElement): () => void {
  let dragging = false;
  let x = 0;
  let y = 0;
  let frame = 0;
  let anchor: { node: Node; offset: number } | undefined;
  const clamp = () => {
    if (!dragging) return;
    frame = requestAnimationFrame(clamp);
    const box = viewport.getBoundingClientRect();
    const left = box.left + viewport.clientLeft;
    const top = box.top + viewport.clientTop;
    const right = left + viewport.clientWidth - 1;
    const bottom = top + viewport.clientHeight - 1;
    const selection = document.getSelection();
    if (!selection) return;
    if (!anchor) {
      // The first frame after the press: the browser has placed the start of
      // the selection. Chromium may move it once a script has changed the
      // selection, so it is read once and restored with each correction.
      if (!selection.anchorNode || !viewport.contains(selection.anchorNode))
        return stop();
      anchor = { node: selection.anchorNode, offset: selection.anchorOffset };
    }
    if (x >= left && x <= right && y >= top && y <= bottom) return;
    const caret = caretAt(
      Math.min(Math.max(x, left + 1), right - 1),
      Math.min(Math.max(y, top + 1), bottom - 1),
    );
    if (!caret || !viewport.contains(caret.node)) return;
    if (
      selection.anchorNode !== anchor.node ||
      selection.anchorOffset !== anchor.offset ||
      selection.focusNode !== caret.node ||
      selection.focusOffset !== caret.offset
    )
      selection.setBaseAndExtent(
        anchor.node,
        anchor.offset,
        caret.node,
        caret.offset,
      );
  };
  const stop = () => {
    dragging = false;
    anchor = undefined;
    cancelAnimationFrame(frame);
  };
  const down = (event: PointerEvent) => {
    // Touch selection uses the platform's handles, which already stay put.
    if (event.button !== 0 || event.pointerType === "touch") return;
    // A press on the scroll bar drags the page, not a selection.
    if (
      event.target === viewport &&
      (event.offsetX >= viewport.clientWidth ||
        event.offsetY >= viewport.clientHeight)
    )
      return;
    stop();
    dragging = true;
    x = event.clientX;
    y = event.clientY;
    frame = requestAnimationFrame(clamp);
  };
  const move = (event: PointerEvent) => {
    x = event.clientX;
    y = event.clientY;
  };
  viewport.addEventListener("pointerdown", down);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", stop, true);
  window.addEventListener("pointercancel", stop, true);
  window.addEventListener("blur", stop);
  return () => {
    stop();
    viewport.removeEventListener("pointerdown", down);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", stop, true);
    window.removeEventListener("pointercancel", stop, true);
    window.removeEventListener("blur", stop);
  };
}

function caretAt(x: number, y: number) {
  if (typeof document.caretPositionFromPoint === "function") {
    const caret = document.caretPositionFromPoint(x, y);
    return caret && { node: caret.offsetNode, offset: caret.offset };
  }
  // Safari before 18.4.
  const range = (
    document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }
  ).caretRangeFromPoint?.(x, y);
  return range && { node: range.startContainer, offset: range.startOffset };
}
