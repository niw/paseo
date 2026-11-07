import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import type { ReservedRegionsSnapshot } from "./reserved-regions-types";

interface PaseoReservedRegionsModule {
  getSnapshot(): Promise<ReservedRegionsSnapshot>;
  addListener(
    eventName: "onChange",
    handler: (snapshot: ReservedRegionsSnapshot) => void,
  ): EventSubscription;
}

// Optional: a dev client built before the module existed keeps working without it.
const module = requireOptionalNativeModule<PaseoReservedRegionsModule>("PaseoReservedRegions");

export function subscribeReservedRegions(
  onSnapshot: (snapshot: ReservedRegionsSnapshot) => void,
): () => void {
  if (!module) return () => {};
  const subscription = module.addListener("onChange", onSnapshot);
  void module.getSnapshot().then(onSnapshot, () => undefined);
  return () => subscription.remove();
}
