import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { useToast } from "@/contexts/toast-context";

export function useCopyResumeCommand(): (command: string) => Promise<void> {
  const { t } = useTranslation();
  const toast = useToast();
  return useCallback(
    async (command: string) => {
      try {
        await Clipboard.setStringAsync(command);
        toast.copied(t("workspace.tabs.toasts.resumeCommandCopiedLabel"));
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [toast, t],
  );
}
