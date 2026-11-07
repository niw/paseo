import type { ReservedRegionsSnapshot } from "./reserved-regions-types";

/** Only iOS reports reserved regions. */
export function subscribeReservedRegions(
  _onSnapshot: (snapshot: ReservedRegionsSnapshot) => void,
): () => void {
  return () => {};
}
