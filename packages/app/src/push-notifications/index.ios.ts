import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";

// The iOS app is built without APNs, so it never asks for notification permission or fetches an
// Expo push token, and the daemon has nothing to send to.
export function startPushNotifications(_input: StartPushNotificationsInput): () => void {
  return () => undefined;
}

export async function revokePushNotifications(_input: RevokePushNotificationsInput): Promise<void> {
  // Nothing was registered.
}
