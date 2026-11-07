import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import {
  DESKTOP_TRAFFIC_LIGHT_HEIGHT,
  DESKTOP_TRAFFIC_LIGHT_WIDTH,
  getIsElectronRuntime,
} from "@/constants/layout";
import { getDesktopWindow } from "@/desktop/electron/window";
import { getDesktopWindowChromeMode, type DesktopWindowChromeMode } from "@/desktop/host";
import {
  getDesktopWindowControlsPresentation,
  getDesktopWindowControlsWidth,
} from "@/desktop/window-chrome-presentation";
import { isNative } from "@/constants/platform";
import { useRegionEdges, useTopChromeGeometry } from "@/components/safe-area-edges";
import {
  resolveTopRowClearance,
  resolveTopStackPadding,
  TOP_ROW_HEIGHT,
  type TopChromeSides,
  type TopRowClearance,
} from "@/components/top-band";

export type WindowChromeCorners = "none" | "top-left" | "top-right" | "both";
type WindowChromeSafeAreaPlacement = "inline" | "below";

interface WindowChromeCornerObstruction {
  width: number;
  height: number;
}

interface WindowChromeObstruction {
  topLeft: WindowChromeCornerObstruction | null;
  topRight: WindowChromeCornerObstruction | null;
}

export type WindowChromeCorner = "top-left" | "top-right";

type WindowChromeSafeAreaStyle = { height: number } | { paddingLeft: number; paddingRight: number };

const EMPTY_OBSTRUCTION: WindowChromeObstruction = { topLeft: null, topRight: null };
const WindowChromeContext = createContext<WindowChromeObstruction>(EMPTY_OBSTRUCTION);
const WindowChromeCornersContext = createContext<WindowChromeCorners>("none");
const DesktopWindowChromeContext = createContext<{
  mode: DesktopWindowChromeMode | null;
  isFullscreen: boolean;
  isMaximized: boolean;
}>({ mode: null, isFullscreen: false, isMaximized: false });

function windowChromeCornersFromFlags(topLeft: boolean, topRight: boolean): WindowChromeCorners {
  if (topLeft && topRight) return "both";
  if (topLeft) return "top-left";
  if (topRight) return "top-right";
  return "none";
}

export function windowChromeCornersInclude(
  corners: WindowChromeCorners,
  corner: WindowChromeCorner,
): boolean {
  return corners === "both" || corners === corner;
}

export function resolveHasOwnedWindowChromeObstruction(input: {
  obstruction: WindowChromeObstruction;
  corners: WindowChromeCorners;
  corner: WindowChromeCorner;
}): boolean {
  if (!windowChromeCornersInclude(input.corners, input.corner)) return false;
  return input.corner === "top-left"
    ? input.obstruction.topLeft !== null
    : input.obstruction.topRight !== null;
}

export function useHasWindowChromeObstruction(corner: WindowChromeCorner): boolean {
  const obstruction = useContext(WindowChromeContext);
  return corner === "top-left" ? obstruction.topLeft !== null : obstruction.topRight !== null;
}

export function intersectWindowChromeCorners(
  inherited: WindowChromeCorners,
  declared: WindowChromeCorners,
): WindowChromeCorners {
  const inheritedTopLeft = inherited === "top-left" || inherited === "both";
  const inheritedTopRight = inherited === "top-right" || inherited === "both";
  const declaredTopLeft = declared === "top-left" || declared === "both";
  const declaredTopRight = declared === "top-right" || declared === "both";
  return windowChromeCornersFromFlags(
    inheritedTopLeft && declaredTopLeft,
    inheritedTopRight && declaredTopRight,
  );
}

export function removeWindowChromeCorner(
  corners: WindowChromeCorners,
  corner: WindowChromeCorner,
): WindowChromeCorners {
  if (!windowChromeCornersInclude(corners, corner)) return corners;
  if (corners !== "both") return "none";
  return corner === "top-left" ? "top-right" : "top-left";
}

export function resolveWindowChromeObstruction(input: {
  mode: DesktopWindowChromeMode | null;
  isFullscreen: boolean;
}): WindowChromeObstruction {
  if (!input.mode || input.isFullscreen) return EMPTY_OBSTRUCTION;
  if (input.mode === "native-mac") {
    return {
      topLeft: { width: DESKTOP_TRAFFIC_LIGHT_WIDTH, height: DESKTOP_TRAFFIC_LIGHT_HEIGHT },
      topRight: null,
    };
  }
  const presentation = getDesktopWindowControlsPresentation(input.mode);
  return {
    topLeft: null,
    topRight: {
      width: getDesktopWindowControlsWidth(input.mode),
      height: presentation.railHeight,
    },
  };
}

export function resolveWindowChromeSafeArea(input: {
  obstruction: WindowChromeObstruction;
  corners: WindowChromeCorners;
  placement: WindowChromeSafeAreaPlacement;
}): WindowChromeSafeAreaStyle {
  const ownsTopLeft = input.corners === "top-left" || input.corners === "both";
  const ownsTopRight = input.corners === "top-right" || input.corners === "both";
  const topLeft = ownsTopLeft ? input.obstruction.topLeft : null;
  const topRight = ownsTopRight ? input.obstruction.topRight : null;
  if (input.placement === "below") {
    return { height: Math.max(topLeft?.height ?? 0, topRight?.height ?? 0) };
  }
  return { paddingLeft: topLeft?.width ?? 0, paddingRight: topRight?.width ?? 0 };
}

export function WindowChromeProvider({ children }: { children: ReactNode }) {
  const [isElectronReady, setIsElectronReady] = useState(getIsElectronRuntime);
  const [windowState, setWindowState] = useState({ isFullscreen: false, isMaximized: false });

  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    let connecting = false;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function scheduleRetry(warnOnExhaustion = false) {
      if (!active || dispose || retryTimer) return;
      if (retryCount >= 40) {
        if (warnOnExhaustion) {
          console.warn("[DesktopWindow] Chrome bridge unavailable; window controls may overlap UI");
        }
        return;
      }
      retryCount += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, 250);
    }

    function connect() {
      if (!active || dispose || connecting) return;
      if (!getIsElectronRuntime()) return scheduleRetry();
      const desktopWindow = getDesktopWindow();
      if (
        !desktopWindow ||
        typeof desktopWindow.isFullscreen !== "function" ||
        typeof desktopWindow.onResized !== "function"
      )
        return scheduleRetry(true);
      const readFullscreen = desktopWindow.isFullscreen;
      const readMaximized = desktopWindow.isMaximized;
      const subscribeToResized = desktopWindow.onResized;
      connecting = true;
      void (async () => {
        async function syncWindowState() {
          try {
            const [isFullscreen, isMaximized] = await Promise.all([
              readFullscreen(),
              readMaximized?.() ?? false,
            ]);
            if (active) setWindowState({ isFullscreen, isMaximized });
          } catch (error) {
            if (active) console.warn("[DesktopWindow] Failed to read window state", error);
          }
        }
        try {
          const nextDispose = await subscribeToResized(syncWindowState);
          if (!active) return nextDispose();
          dispose = nextDispose;
          setIsElectronReady(true);
          await syncWindowState();
        } catch (error) {
          if (active) console.warn("[DesktopWindow] Failed to subscribe to resize", error);
        } finally {
          connecting = false;
          if (!dispose) scheduleRetry();
        }
      })();
    }

    if (!isNative) connect();

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      dispose?.();
    };
  }, []);

  const obstruction = useMemo(
    () =>
      resolveWindowChromeObstruction({
        mode: isElectronReady ? getDesktopWindowChromeMode() : null,
        isFullscreen: windowState.isFullscreen,
      }),
    [isElectronReady, windowState.isFullscreen],
  );
  const desktopWindowChrome = useMemo(
    () => ({
      mode: isElectronReady ? getDesktopWindowChromeMode() : null,
      isFullscreen: windowState.isFullscreen,
      isMaximized: windowState.isMaximized,
    }),
    [isElectronReady, windowState],
  );
  return (
    <DesktopWindowChromeContext.Provider value={desktopWindowChrome}>
      <WindowChromeContext.Provider value={obstruction}>
        <WindowChromeCornersContext.Provider value="both">
          {children}
        </WindowChromeCornersContext.Provider>
      </WindowChromeContext.Provider>
    </DesktopWindowChromeContext.Provider>
  );
}

export function useCustomDesktopWindowControls(): {
  visible: boolean;
  mode: "custom-windows" | "custom-linux" | null;
  isMaximized: boolean;
} {
  const chrome = useContext(DesktopWindowChromeContext);
  const customMode =
    chrome.mode === "custom-windows" || chrome.mode === "custom-linux" ? chrome.mode : null;
  return {
    visible: customMode !== null && !chrome.isFullscreen,
    mode: customMode,
    isMaximized: chrome.isMaximized,
  };
}

/** Narrows inherited corner ownership to the corners occupied by this child surface. */
export function WindowChromeRegion({
  corners,
  children,
}: {
  corners: WindowChromeCorners;
  children: ReactNode;
}) {
  const inheritedCorners = useContext(WindowChromeCornersContext);
  const ownedCorners = intersectWindowChromeCorners(inheritedCorners, corners);
  return (
    <WindowChromeCornersContext.Provider value={ownedCorners}>
      {children}
    </WindowChromeCornersContext.Provider>
  );
}

/** Restarts ownership for a new physical viewport such as a Modal or full-window overlay. */
export function WindowChromeRootRegion({
  corners,
  children,
}: {
  corners: WindowChromeCorners;
  children: ReactNode;
}) {
  return (
    <WindowChromeCornersContext.Provider value={corners}>
      {children}
    </WindowChromeCornersContext.Provider>
  );
}

export function useWindowChromeCorners(): WindowChromeCorners {
  return useContext(WindowChromeCornersContext);
}

export function useOwnsWindowChromeCorner(corner: WindowChromeCorner): boolean {
  const corners = useContext(WindowChromeCornersContext);
  return windowChromeCornersInclude(corners, corner);
}

export function useHasOwnedWindowChromeObstruction(corner: WindowChromeCorner): boolean {
  const obstruction = useContext(WindowChromeContext);
  const corners = useContext(WindowChromeCornersContext);
  return resolveHasOwnedWindowChromeObstruction({ obstruction, corners, corner });
}

/**
 * The top corners a stack of rows at the top of this region sits in: those the region owns
 * (`WindowChromeRegion`) on window edges it touches (`HorizontalSafeAreaRegion`).
 */
function useTopChromeSides(): TopChromeSides {
  const corners = useContext(WindowChromeCornersContext);
  const edges = useRegionEdges();
  const left = edges.left && windowChromeCornersInclude(corners, "top-left");
  const right = edges.right && windowChromeCornersInclude(corners, "top-right");
  return useMemo(() => ({ left, right }), [left, right]);
}

interface TopChromeStackState {
  hostRef: RefObject<View | null>;
  sides: TopChromeSides;
  paddingTop: number;
  /** Changes whenever the rows in the stack can have moved. */
  layoutVersion: number;
}

const TopChromeStackContext = createContext<TopChromeStackState | null>(null);

interface TopChromeStackProps {
  style?: StyleProp<ViewStyle>;
  /** The rows' height before they are measured, so the first frame lands close. */
  estimatedHeight?: number;
  children: ReactNode;
}

/**
 * The rows at the top of a region, like a header and its tab row. The stack replaces
 * `insets.top` with `resolveTopStackPadding`: beside a block that covers one top corner, like
 * iPhone Duo's camera and status block, rows that reach the block's bottom start at the window's
 * top, and each row in the stack moves its ends in past the block where it sits beside it
 * (`useTopChromeRow`). A stack inside another stack adds nothing; the outer one places its rows.
 */
export function TopChromeStack({ style, estimatedHeight, children }: TopChromeStackProps) {
  const parent = useContext(TopChromeStackContext);
  if (parent) return <View style={style}>{children}</View>;
  return (
    <RootTopChromeStack style={style} estimatedHeight={estimatedHeight}>
      {children}
    </RootTopChromeStack>
  );
}

function RootTopChromeStack({
  style,
  estimatedHeight = TOP_ROW_HEIGHT,
  children,
}: TopChromeStackProps) {
  const { band, topInset } = useTopChromeGeometry();
  const sides = useTopChromeSides();
  const hostRef = useRef<View>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const paddingTop = resolveTopStackPadding({
    band,
    topInset,
    sides,
    contentHeight: contentHeight ?? estimatedHeight,
  });
  // The content moves when the padding changes and resizes when a row does; either moves rows.
  const handleContentLayout = useCallback((event: LayoutChangeEvent) => {
    setContentHeight(event.nativeEvent.layout.height);
    setLayoutVersion((version) => version + 1);
  }, []);
  const hostStyle = useMemo(() => [style, { paddingTop }], [paddingTop, style]);
  const state = useMemo(
    () => ({ hostRef, sides, paddingTop, layoutVersion }),
    [layoutVersion, paddingTop, sides],
  );
  return (
    <View ref={hostRef} style={hostStyle} collapsable={false}>
      <View onLayout={handleContentLayout}>
        <TopChromeStackContext.Provider value={state}>{children}</TopChromeStackContext.Provider>
      </View>
    </View>
  );
}

/**
 * Top padding for a single row at the top of this region that is not in a `TopChromeStack`,
 * such as a sidebar's first row or the explorer's tab rail. Pass the row's height; `paddingTop`
 * replaces `insets.top`. Inside a stack it is 0: the stack pads its rows.
 */
export function useTopChromeInsets(rowHeight: number): { paddingTop: number } {
  const stack = useContext(TopChromeStackContext);
  const { band, topInset } = useTopChromeGeometry();
  const sides = useTopChromeSides();
  const paddingTop = stack
    ? 0
    : resolveTopStackPadding({ band, topInset, sides, contentHeight: rowHeight });
  return useMemo(() => ({ paddingTop }), [paddingTop]);
}

const NO_CLEARANCE: TopRowClearance = { left: 0, right: 0 };

function useTopRowClearance(
  sides: TopChromeSides,
  row: { top: number; height: number } | null,
): TopRowClearance {
  const { band, insets, radii } = useTopChromeGeometry();
  const top = row?.top ?? null;
  const height = row?.height ?? 0;
  const clearance =
    top === null
      ? NO_CLEARANCE
      : resolveTopRowClearance({ band, sides, insets, radii, row: { top, height } });
  const { left, right } = clearance;
  return useMemo(() => ({ left, right }), [left, right]);
}

/**
 * Where a row at the top of this region would sit alone: a touch-sized row at the bottom of the
 * stack padding. For rows that are not measured in a `TopChromeStack`.
 */
function useUnmeasuredTopRow(sides: TopChromeSides): { top: number; height: number } {
  const { band, topInset } = useTopChromeGeometry();
  const top = resolveTopStackPadding({ band, topInset, sides, contentHeight: TOP_ROW_HEIGHT });
  return useMemo(() => ({ top, height: TOP_ROW_HEIGHT }), [top]);
}

/**
 * How far a row at the top of this region moves its ends in, beyond the side insets, to clear
 * what covers the window's top corners: the display's rounded corners and a block that covers a
 * corner of the top band. Only for the corners this region's top row owns (`WindowChromeRegion`)
 * on window edges the region touches (`HorizontalSafeAreaRegion`). For a single top row outside a
 * `TopChromeStack`; a row in a stack reads `useTopChromeRow`, and `WindowChromeSafeArea` does.
 */
export function useWindowChromeCornerInsets(): TopRowClearance {
  const sides = useTopChromeSides();
  const row = useUnmeasuredTopRow(sides);
  return useTopRowClearance(sides, row);
}

/**
 * A row in a `TopChromeStack`: attach `ref` and `onLayout` to the row's outer view and add
 * `left` and `right` to its inline padding. The stack measures where the row sits and the row
 * moves its ends in past whatever covers the window's top corners beside it. Outside a stack the
 * row is the region's single top row (`useWindowChromeCornerInsets`).
 */
export function useTopChromeRow(): TopRowClearance & {
  ref: RefObject<View | null>;
  onLayout: () => void;
} {
  const stack = useContext(TopChromeStackContext);
  const regionSides = useTopChromeSides();
  const unmeasuredRow = useUnmeasuredTopRow(regionSides);
  const ref = useRef<View>(null);
  const [frame, setFrame] = useState<{ top: number; height: number } | null>(null);
  const hostRef = stack?.hostRef ?? null;
  const layoutVersion = stack?.layoutVersion ?? 0;
  const measure = useCallback(() => {
    const row = ref.current;
    const host = hostRef?.current;
    if (!row || !host) return;
    row.measureLayout(
      host,
      (_left, top, _width, height) => {
        setFrame((previous) =>
          previous?.top === top && previous.height === height ? previous : { top, height },
        );
      },
      () => undefined,
    );
  }, [hostRef]);
  useEffect(() => {
    measure();
  }, [layoutVersion, measure]);
  // Before the first measurement a row in a stack is taken for the stack's first row.
  const stackRow = frame ?? (stack ? { top: stack.paddingTop, height: TOP_ROW_HEIGHT } : null);
  const clearance = useTopRowClearance(
    stack ? stack.sides : regionSides,
    stack ? stackRow : unmeasuredRow,
  );
  return useMemo(
    () => ({ ref, onLayout: measure, left: clearance.left, right: clearance.right }),
    [clearance.left, clearance.right, measure],
  );
}

type WindowChromeSafeAreaProps = ViewProps & {
  placement: WindowChromeSafeAreaPlacement;
  horizontalPadding?: number;
  /** Extra inline padding per side, such as the horizontal safe-area insets. */
  paddingLeftExtra?: number;
  paddingRightExtra?: number;
};

export function WindowChromeSafeArea({
  placement,
  horizontalPadding = 0,
  paddingLeftExtra = 0,
  paddingRightExtra = 0,
  style,
  onLayout,
  ...props
}: WindowChromeSafeAreaProps) {
  const obstruction = useContext(WindowChromeContext);
  const corners = useContext(WindowChromeCornersContext);
  // What covers the window's top corners never pushes a row down; an inline row moves its ends
  // in past it.
  const cornerInsets = useTopChromeRow();
  const safeAreaStyle = useMemo(() => {
    const resolved = resolveWindowChromeSafeArea({ obstruction, corners, placement });
    if (placement === "below") return resolved;
    const paddingLeft = "paddingLeft" in resolved ? resolved.paddingLeft : 0;
    const paddingRight = "paddingRight" in resolved ? resolved.paddingRight : 0;
    return {
      paddingLeft: Math.max(paddingLeft, cornerInsets.left) + horizontalPadding + paddingLeftExtra,
      paddingRight:
        Math.max(paddingRight, cornerInsets.right) + horizontalPadding + paddingRightExtra,
    };
  }, [
    cornerInsets.left,
    cornerInsets.right,
    corners,
    horizontalPadding,
    obstruction,
    paddingLeftExtra,
    paddingRightExtra,
    placement,
  ]);
  const combinedStyle = useMemo(() => [style, safeAreaStyle], [safeAreaStyle, style]);
  const measureRow = cornerInsets.onLayout;
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      measureRow();
      onLayout?.(event);
    },
    [measureRow, onLayout],
  );
  return <View {...props} ref={cornerInsets.ref} onLayout={handleLayout} style={combinedStyle} />;
}
