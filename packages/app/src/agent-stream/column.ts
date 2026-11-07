import { createContext, useContext, useMemo } from "react";
import { SPACING } from "@/styles/theme";

/** The stream list's horizontal padding, inside which each row centers its column. */
export const STREAM_LIST_HORIZONTAL_PADDING = { compact: SPACING[3], regular: SPACING[4] };
/** A row's own horizontal padding inside its column. */
export const STREAM_ROW_HORIZONTAL_PADDING = SPACING[2];

export interface StreamColumnInsets {
  left: number;
  right: number;
}

export interface StreamColumn {
  /** Margins for the list's content container. */
  marginLeft: number;
  marginRight: number;
  /** How far each side inset still covers a row's content; see `useStreamColumnInsets`. */
  insets: StreamColumnInsets;
}

/**
 * Where the chat's rows go. The list runs edge to edge, under the side insets. While the rows fill
 * the width, so does their text. Once they reach their maximum width they center where the
 * composer centers, between the side insets, as far as the free space allows: with an inset on one
 * side only, like iPhone Duo's camera strip, centering across the whole width would leave the
 * column off the composer's center.
 */
export function resolveStreamColumn(input: {
  width: number;
  insetLeft: number;
  insetRight: number;
  maxWidth: number;
  listPadding: number;
}): StreamColumn {
  const { width, insetLeft, insetRight, maxWidth, listPadding } = input;
  const free = Math.max(0, width - 2 * listPadding - maxWidth);
  const offset = insetLeft - insetRight;
  const shift = Math.sign(offset) * Math.min(Math.abs(offset), free);
  const marginLeft = Math.max(0, shift);
  const marginRight = Math.max(0, -shift);
  const available = width - marginLeft - marginRight - 2 * listPadding;
  const columnWidth = Math.min(maxWidth, available);
  const columnLeft = marginLeft + listPadding + (available - columnWidth) / 2;
  // A control keeps the same padding from an inset that a row keeps from the window's edge.
  const edgePadding = listPadding + STREAM_ROW_HORIZONTAL_PADDING;
  const contentLeft = columnLeft + STREAM_ROW_HORIZONTAL_PADDING;
  const contentRight = columnLeft + columnWidth - STREAM_ROW_HORIZONTAL_PADDING;
  return {
    marginLeft,
    marginRight,
    insets: {
      left: Math.max(0, insetLeft + edgePadding - contentLeft),
      right: Math.max(0, contentRight - (width - insetRight - edgePadding)),
    },
  };
}

const NO_COLUMN_INSETS: StreamColumnInsets = { left: 0, right: 0 };

export const StreamColumnInsetsContext = createContext<StreamColumnInsets>(NO_COLUMN_INSETS);

/**
 * How far a row's controls move in to stay inside the side insets, where the stream's text runs
 * under them. Zero outside the native stream and where the column already clears the insets.
 */
export function useStreamColumnInsets(): StreamColumnInsets {
  return useContext(StreamColumnInsetsContext);
}

/**
 * Horizontal padding for a stream row whose content stays inside the side insets: everything but
 * the messages' text, like tool calls, permission prompts and the turn footer.
 */
export function useStreamControlsRowPadding(): { paddingLeft: number; paddingRight: number } {
  const { left, right } = useStreamColumnInsets();
  return useMemo(
    () => ({
      paddingLeft: STREAM_ROW_HORIZONTAL_PADDING + left,
      paddingRight: STREAM_ROW_HORIZONTAL_PADDING + right,
    }),
    [left, right],
  );
}
