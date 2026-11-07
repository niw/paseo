import { View } from "react-native";
import { useEdgeBleedStyle } from "@/components/padded-side-insets";
import { StyleSheet } from "react-native-unistyles";

/**
 * Edge-to-edge separator line for sidebars. Must render outside any horizontally
 * padded container so the line runs the full sidebar width — matching the
 * separator beneath the workspace sidebar's "New agent" header.
 */
export function SidebarSeparator({ testID }: { testID?: string } = {}) {
  // Past a side inset the sidebar pads its rows; the line still reaches its edges.
  const edgeBleedStyle = useEdgeBleedStyle();
  return <View style={[styles.line, edgeBleedStyle]} testID={testID} />;
}

const styles = StyleSheet.create((theme) => ({
  line: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
}));
