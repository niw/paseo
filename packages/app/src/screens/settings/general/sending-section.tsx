import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { isWeb } from "@/constants/platform";
import { useAppSettings, type SendBehavior, type SendKey } from "@/hooks/use-settings";

const SEND_BEHAVIORS: readonly SendBehavior[] = ["interrupt", "steer", "queue"];
const SEND_KEYS: readonly SendKey[] = ["enter", "mod-enter"];

export function SendingSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const behaviorOptions = useMemo(
    () =>
      SEND_BEHAVIORS.map((value) => ({
        value,
        label: t(`settings.general.defaultSend.options.${value}`),
      })),
    [t],
  );
  const keyOptions = useMemo(
    () =>
      SEND_KEYS.map((value) => ({
        value,
        label: t(`settings.general.sendKey.options.${value}`),
      })),
    [t],
  );
  const changeBehavior = useCallback(
    (sendBehavior: SendBehavior) => void updateSettings({ sendBehavior }),
    [updateSettings],
  );
  const changeKey = useCallback(
    (sendKey: SendKey) => void updateSettings({ sendKey }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.general.sending")}>
      <SettingsCard>
        {/* Only the desktop composer submits from the keyboard; native Enter always adds a line. */}
        {isWeb ? (
          <SettingsSelect
            label={t("settings.general.sendKey.label")}
            hint={t(`settings.general.sendKey.descriptions.${settings.sendKey}`)}
            value={settings.sendKey}
            options={keyOptions}
            onValueChange={changeKey}
          />
        ) : null}
        <SettingsSelect
          label={t("settings.general.defaultSend.label")}
          hint={t(`settings.general.defaultSend.descriptions.${settings.sendBehavior}`, {
            send: t(`settings.general.sendKey.options.${settings.sendKey}`),
            alternate: t(`settings.general.sendKey.alternate.${settings.sendKey}`),
          })}
          value={settings.sendBehavior}
          options={behaviorOptions}
          onValueChange={changeBehavior}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
