import { createContext, useContext } from "react";

const StreamBottomOverlayContext = createContext(0);

/**
 * Visual-bottom clearance for chrome that floats over the stream, in points. The composer dock
 * supplies it when the stream runs behind the composer to the bottom edge.
 */
export const StreamBottomOverlayProvider = StreamBottomOverlayContext.Provider;

export function useStreamBottomOverlayInset(): number {
  return useContext(StreamBottomOverlayContext);
}
