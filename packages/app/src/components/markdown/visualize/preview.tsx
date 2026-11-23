import { useId, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { FileHtmlPreview } from "@/file-panels/html-preview";
import { useStableEvent } from "@/hooks/use-stable-event";
import { decodeUtf8 } from "@/utils/decode-utf8";
import type { MarkdownImageContext } from "../images";
import { VISUALIZE_WIDE_WIDTH, type VisualizeReference } from "./reference";

const MAX_VISUALIZE_BYTES = 1_000_000;
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

export function VisualizePreview({
  reference,
  context,
}: {
  reference: VisualizeReference;
  context: MarkdownImageContext;
}) {
  const { t } = useTranslation();
  const { client, serverId, workspaceRoot } = context;
  const target = resolveFilePreviewReadTarget({
    path: reference.path,
    workspaceRoot,
  });
  const title = reference.title?.trim() || "Visualize";
  const [opened, setOpened] = useState(false);
  const accessibilityState = useMemo(() => ({ expanded: opened }), [opened]);
  const togglePreview = useStableEvent(() => setOpened((previous) => !previous));
  const isWide = reference.mode === "wide";
  const preview = t("panels.file.editor.preview");
  const close = t("common.actions.close");
  return (
    <View style={isWide ? styles.wide : styles.normal} testID="visualize-block">
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Button
          size="sm"
          variant="outline"
          accessibilityState={accessibilityState}
          onPress={togglePreview}
        >
          {opened ? close : preview}
        </Button>
      </View>
      {opened && (
        <VisualizeDocument title={title} target={target} client={client} serverId={serverId} />
      )}
    </View>
  );
}

interface DocumentProps {
  title: string;
  target: ReturnType<typeof resolveFilePreviewReadTarget>;
  client: MarkdownImageContext["client"];
  serverId: string | undefined;
}

function VisualizeDocument({ title, target, client, serverId }: DocumentProps) {
  const { t } = useTranslation();
  const occurrence = useId();
  const file = useFetchQuery({
    queryKey: ["visualizeFile", serverId, occurrence, target?.cwd, target?.path],
    dataShape: "value",
    immutableWhen: () => true,
    enabled: Boolean(client && target),
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      if (!client || !target) throw new Error("Visualize host unavailable");
      const read = await client.readFile(
        target.cwd,
        target.path,
        undefined,
        MAX_VISUALIZE_BYTES - 1,
      );
      if (read.kind !== "text" || read.bytes.byteLength >= MAX_VISUALIZE_BYTES) {
        throw new Error("Invalid Visualize HTML file");
      }
      return decodeUtf8(read.bytes);
    },
  });
  const retry = useStableEvent(() => void file.refetch());
  if (file.data !== undefined) {
    const html = VIEWPORT + file.data;
    return (
      <View style={styles.frame}>
        <FileHtmlPreview html={html} title={title} testID="visualize-preview" />
      </View>
    );
  }
  if (file.isFetching) {
    return (
      <Text style={styles.status} accessibilityLiveRegion="polite">
        {t("panels.file.loading")}
      </Text>
    );
  }
  return (
    <View style={styles.header}>
      <Text style={styles.status} accessibilityLiveRegion="polite">
        {t("panels.file.failedToLoadPreview")}
      </Text>
      <Button size="sm" variant="outline" disabled={!client || !target} onPress={retry}>
        {t("common.actions.retry")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  normal: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
  },
  wide: {
    width: "100%",
    maxWidth: VISUALIZE_WIDE_WIDTH,
    alignSelf: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  status: {
    marginTop: theme.spacing[2],
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  frame: {
    height: 420,
    marginTop: theme.spacing[2],
    overflow: "hidden",
    borderRadius: theme.borderRadius.lg,
  },
}));
