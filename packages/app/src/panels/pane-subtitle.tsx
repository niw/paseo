import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHorizontalSafeAreaPadding } from "@/components/safe-area-edges";
import { SPACING } from "@/styles/theme";

/**
 * One muted line of facts about a pane's agent, under the pane's header and above its stream:
 * model, thinking, tokens. Provider subagents get it from the daemon; a Paseo agent shown without
 * its composer gets it from the same facts the composer's controls show.
 */
export function PaneSubtitle({ text, testID }: { text: string; testID?: string }) {
  // The line's border runs under the side insets; its text stays inside them.
  const safeAreaPadding = useHorizontalSafeAreaPadding(SPACING[3]);
  const headerStyle = useMemo(() => [styles.header, safeAreaPadding], [safeAreaPadding]);
  return (
    <View style={headerStyle}>
      <Text style={styles.text} numberOfLines={1} testID={testID}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
