import { useCallback, useState, type PropsWithChildren, type ReactNode } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Copy, Folder } from "lucide-react-native";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { shortenPath } from "@/utils/shorten-path";

const HOVER_CARD_WIDTH = 320;
const COPIED_MS = 2000;

const ThemedFolder = withUnistyles(Folder);
const ThemedCopy = withUnistyles(Copy);
const ThemedCheck = withUnistyles(Check);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ProjectHoverCardProps {
  projectName: string;
  /** The project's directory on each of its hosts. */
  directories: readonly string[];
  projectKey: string;
  disabled?: boolean;
}

/**
 * Shows a project's directories while the pointer is on its sidebar row, so projects with the
 * same name can be told apart. Like the workspace hover card it needs hover, so compact layouts
 * and native render the row alone. The project screen in Settings shows the directory there.
 */
export function ProjectHoverCard({
  projectName,
  directories,
  projectKey,
  disabled = false,
  children,
}: PropsWithChildren<ProjectHoverCardProps>): ReactNode {
  const isCompact = useIsCompactFormFactor();
  const uniqueDirectories = [...new Set(directories.filter((directory) => directory.length > 0))];

  if (isCompact || uniqueDirectories.length === 0) {
    return children;
  }

  return (
    <HoverCard disabled={disabled}>
      <HoverCardTrigger>{children}</HoverCardTrigger>
      <HoverCardContent
        placement="right"
        accessibilityLabel={projectName}
        testID={`project-hover-card-${projectKey}`}
        style={styles.card}
      >
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {projectName}
          </Text>
        </View>
        {uniqueDirectories.map((directory) => (
          <CopyableDirectoryRow
            key={directory}
            directory={directory}
            testID={`project-hover-card-directory-${projectKey}`}
          />
        ))}
      </HoverCardContent>
    </HoverCard>
  );
}

// The workspace hover card's copy row, with the path wrapped: the part that tells two
// directories apart can sit anywhere in it.
function CopyableDirectoryRow({ directory, testID }: { directory: string; testID: string }) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  // The card sits over the row, so a press here must not also press the row.
  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);
  const handlePress = useCallback(() => {
    void copyToClipboard(directory);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  }, [directory]);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  const highlighted = copied || isHovered;
  const iconUniProps = highlighted ? foregroundColorMapping : foregroundMutedColorMapping;
  let icon = <ThemedFolder size={12} uniProps={iconUniProps} />;
  if (copied) {
    icon = <ThemedCheck size={12} uniProps={iconUniProps} />;
  } else if (isHovered) {
    icon = <ThemedCopy size={12} uniProps={iconUniProps} />;
  }

  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={t("workspace.hoverCard.copyPath")}
      style={styles.infoRow}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
    >
      <View style={styles.infoIcon}>{icon}</View>
      <Text style={[styles.infoText, highlighted && styles.infoTextHighlighted]} testID={testID}>
        {shortenPath(directory)}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    paddingTop: theme.spacing[2],
    width: HOVER_CARD_WIDTH,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
  cardHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  // Keeps the icon on the first line of a wrapped path.
  infoIcon: {
    height: 18,
    justifyContent: "center",
  },
  infoText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  infoTextHighlighted: {
    color: theme.colors.foreground,
  },
}));
