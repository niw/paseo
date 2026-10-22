import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

const fullscreenOptions = { enable: true };

/** Plays a local copy of a video or audio file with the platform's own controls. */
export function MediaPreview({ uri, testID }: { uri: string; testID?: string }) {
  const { t } = useTranslation();
  const player = useVideoPlayer(uri);
  const { status, error } = useEvent(player, "statusChange", { status: player.status });

  if (status === "error") {
    return (
      <View style={styles.centerState}>
        <Text style={styles.errorText}>
          {error?.message ?? t("panels.file.binaryPreviewUnavailable")}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID={testID}>
      <VideoView
        player={player}
        style={styles.video}
        nativeControls
        contentFit="contain"
        fullscreenOptions={fullscreenOptions}
        allowsPictureInPicture={false}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  video: {
    flex: 1,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
