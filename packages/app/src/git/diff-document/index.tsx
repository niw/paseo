import { useCallback, useMemo, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useVerticalBarInsets } from "@/window-layout";
import { RenderProfile } from "@/utils/render-profiler";
import { createDiffPalette, retainDiffPalette } from "./palette";
import { DiffSurface } from "./surface";
import type { DiffDocumentProps, DiffHeaderTypography, DiffPalette } from "./types";

export type { DiffDocumentProps, WorkingDiffMode } from "./types";

type ThemedDiffDocumentProps = DiffDocumentProps & {
  palette: DiffPalette;
  headerTypography: DiffHeaderTypography;
  headerInsets: { left: number; right: number };
  layoutInsetRight: number;
};

const EMPTY_PATHS: string[] = [];

function ThemedDiffDocument(props: ThemedDiffDocumentProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const paletteRef = useRef(props.palette);
  paletteRef.current = retainDiffPalette(paletteRef.current, props.palette);
  const palette = paletteRef.current;
  const collapseState = props.mode.kind === "working" ? props.collapseState : null;
  const paths = collapseState?.paths ?? EMPTY_PATHS;
  const collapsedFilePaths = useMemo(() => new Set(paths), [paths]);
  const toggleFile = useCallback(
    (path: string) => {
      if (!collapseState) return;
      const next = collapsedFilePaths.has(path)
        ? paths.filter((entry) => entry !== path)
        : [...paths, path];
      collapseState.onChange(next);
    },
    [collapseState, collapsedFilePaths, paths],
  );
  return (
    <DiffSurface
      {...props}
      palette={palette}
      collapsedFilePaths={collapsedFilePaths}
      onToggleFile={toggleFile}
      selectedPath={selectedPath}
      onSelectPath={setSelectedPath}
    />
  );
}

const StyledDiffDocument = withUnistyles(ThemedDiffDocument, (theme) => ({
  palette: createDiffPalette(theme),
  headerTypography: {
    family: theme.fontFamily.ui,
    size: theme.fontSize.base,
    statSize: theme.fontSize.sm,
  },
}));

export function DiffDocument(props: DiffDocumentProps) {
  // A diff is read-only content, so its code runs under the side insets. Its file headers are
  // rows you tap, so their content stays inside them. Beside a vertical bar of actions the
  // document still scrolls to the edge, but lays out only up to the bar's inset. The bar only
  // sits on the right.
  const insets = useSafeAreaInsets();
  const barInsets = useVerticalBarInsets();
  const right = insets.right - barInsets.right;
  const headerInsets = useMemo(() => ({ left: insets.left, right }), [insets.left, right]);
  return (
    <RenderProfile id="DiffDocument">
      <StyledDiffDocument
        {...props}
        headerInsets={headerInsets}
        layoutInsetRight={barInsets.right}
      />
    </RenderProfile>
  );
}
