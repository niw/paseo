import { Text, View } from "react-native";
import { RegionPaddedView } from "@/components/padded-side-insets";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneContentToolbar } from "@/components/ui/pane-content-toolbar";
import { SPACING } from "@/styles/theme";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { PrActivitySkeleton } from "./activity-skeleton";

const CHECK_ROW_KEYS = [0, 1, 2].map((i) => `pr-pane-skeleton-check-${i}`);

export function PullRequestPaneSkeleton() {
  const { t } = useTranslation();
  const pulse = useSkeletonPulse();

  return (
    <View style={styles.root} testID="pr-pane-skeleton">
      <RegionPaddedView style={styles.header}>
        <SkeletonPulse pulse={pulse} style={styles.title} />
        <SkeletonPulse pulse={pulse} style={styles.subtitle} />
      </RegionPaddedView>

      <PaneContentToolbar style={styles.toolbar} paddingLeft={SPACING[3]} paddingRight={SPACING[3]}>
        <SkeletonPulse pulse={pulse} style={styles.toolbarButton} />
        <SkeletonPulse pulse={pulse} style={styles.toolbarButton} />
      </PaneContentToolbar>

      {/* The toolbar runs under the side insets; the sections stay inside them. */}
      <RegionPaddedView>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("workspace.git.pr.sections.checks")}</Text>
          <View style={styles.checks}>
            {CHECK_ROW_KEYS.map((key) => (
              <View key={key} style={styles.checkRow}>
                <SkeletonPulse pulse={pulse} style={styles.checkDot} />
                <SkeletonPulse pulse={pulse} style={styles.checkName} />
              </View>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <PrActivitySkeleton />
        </View>
      </RegionPaddedView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  header: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  title: {
    width: "75%",
    height: 16,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  subtitle: {
    width: "40%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  toolbarButton: {
    width: 96,
    height: 24,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  section: {
    paddingVertical: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  checks: {
    gap: theme.spacing[1],
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    minHeight: 32,
  },
  checkDot: {
    width: 14,
    height: 14,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  checkName: {
    width: "60%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
}));
