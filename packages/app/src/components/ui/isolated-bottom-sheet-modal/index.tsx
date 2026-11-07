import {
  BottomSheetModal as GorhomBottomSheetModal,
  type BottomSheetModalProps,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import React from "react";
import { PaddedSideInsetsProvider } from "@/components/padded-side-insets";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { ElementRef, ReactNode } from "react";
import { systemBackPress } from "./back-press";
import {
  type BottomSheetController,
  createBottomSheetVisibilityTracker,
} from "./visibility-tracker";
import { BottomSheetScope } from "@/components/ui/bottom-sheet-scope";
import { SheetBackdrop } from "./sheet-backdrop";
import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HorizontalSafeAreaRegion } from "@/components/safe-area-edges";

type GorhomBottomSheetModalMethods = ElementRef<typeof GorhomBottomSheetModal>;

/**
 * Re-establishes React context on the far side of the portal.
 *
 * `@gorhom/portal` is not a React portal. It stores the element and a host elsewhere in the tree
 * renders it, so context resolves at the *host's* position: everything provided between
 * `PortalProvider` (see `app/_layout.tsx`) and this sheet is invisible to its content. React
 * cannot copy contexts reflectively, so the only way across is to render the providers again —
 * with values captured out here, where they are still readable.
 *
 * Write it as a closure over what you already have:
 *
 * ```tsx
 * const contextBridge = useCallback<ContextBridge>(
 *   (content) => <ThingContext.Provider value={thing}>{content}</ThingContext.Provider>,
 *   [thing],
 * );
 * ```
 */
export type ContextBridge = (children: ReactNode) => ReactNode;

type IsolatedBottomSheetModalProps = Omit<
  BottomSheetModalProps,
  "enableDismissOnClose" | "stackBehavior" | "children" | "backdropComponent"
> & {
  /**
   * Whether closing (drag, backdrop, Back) also dismisses, which unmounts the content. Default
   * true: the owner hears `onDismiss` and drops its state. Pass `false` for a sheet whose close the
   * owner may veto: it parks at index -1 with its content mounted, the owner hears `onChange(-1)`,
   * and either snaps it back or unmounts it, which dismisses it from the stack.
   */
  enableDismissOnClose?: boolean;
  /**
   * Nodes only. Gorhom also accepts a render function, but nothing here uses it and a bridge
   * would have to reach around it.
   */
  children?: ReactNode;
  presentation?: "push" | "replace";
  /** Show a dismissible backdrop. Its interaction belongs to the modal stack. */
  backdropOpacity?: number;
  /**
   * Required, and `null` is a real answer: a sheet that needs nothing from its call site should
   * have to say so. The failure it prevents is invisible until someone adds a `useContext` deep
   * inside the sheet and it throws on device only.
   */
  contextBridge: ContextBridge | null;
};

export type IsolatedBottomSheetModalRef = GorhomBottomSheetModalMethods;

export const IsolatedBottomSheetModal = forwardRef<
  IsolatedBottomSheetModalRef,
  IsolatedBottomSheetModalProps
>(function IsolatedBottomSheetModal(props, ref) {
  // Gorhom puts this ref into its provider queue and reads `.current` for stack operations.
  // A callback ref accepts the handle but leaves that queue unable to dismiss or restore it.
  const modalRef = useRef<GorhomBottomSheetModalMethods>(null);
  useImperativeHandle(
    ref,
    () => ({
      present: (...args) => modalRef.current?.present(...args),
      dismiss: (...args) => modalRef.current?.dismiss(...args),
      snapToIndex: (...args) => modalRef.current?.snapToIndex(...args),
      snapToPosition: (...args) => modalRef.current?.snapToPosition(...args),
      expand: (...args) => modalRef.current?.expand(...args),
      collapse: (...args) => modalRef.current?.collapse(...args),
      close: (...args) => modalRef.current?.close(...args),
      forceClose: (...args) => modalRef.current?.forceClose(...args),
    }),
    [],
  );
  const {
    children,
    presentation = "push",
    contextBridge,
    backdropOpacity,
    enableDismissOnClose = true,
    ...bottomSheetProps
  } = props;
  const renderBackdrop = useCallback(
    (backdropProps: BottomSheetBackdropProps) => (
      <SheetBackdrop
        {...backdropProps}
        opacity={backdropOpacity}
        pressBehavior={enableDismissOnClose ? "dismiss" : "close"}
      />
    ),
    [backdropOpacity, enableDismissOnClose],
  );
  const modal = (
    <GorhomBottomSheetModal
      {...bottomSheetProps}
      ref={modalRef}
      enableDismissOnClose={enableDismissOnClose}
      stackBehavior={presentation}
      backdropComponent={backdropOpacity === undefined ? undefined : renderBackdrop}
    >
      <BottomSheetScope>
        <SheetHorizontalSafeArea>
          {contextBridge ? contextBridge(children) : children}
        </SheetHorizontalSafeArea>
      </BottomSheetScope>
    </GorhomBottomSheetModal>
  );

  return modal;
});

/**
 * The sheet spans the window and its background runs under the side insets; its content stays
 * inside them. It renders at the sheet host, so the insets read here are the window's. Content
 * below sees no side insets left, and still owns the bottom one. A surface that should reach the
 * sheet's edges is a `SheetFullBleedView`.
 */
function SheetHorizontalSafeArea({ children }: { children: ReactNode }) {
  const { left, right } = useSafeAreaInsets();
  const sideInsets = useMemo(() => ({ left, right }), [left, right]);
  const style = useMemo(
    () => [sheetStyles.body, { paddingLeft: left, paddingRight: right }],
    [left, right],
  );
  return (
    <PaddedSideInsetsProvider value={sideInsets}>
      <HorizontalSafeAreaRegion edges={SHEET_CONTENT_SAFE_AREA_EDGES} style={style}>
        {children}
      </HorizontalSafeAreaRegion>
    </PaddedSideInsetsProvider>
  );
}

const SHEET_CONTENT_SAFE_AREA_EDGES = { left: false, right: false } as const;
// Grows into a fixed-detent sheet and still sizes to content in a dynamically sized one.
const sheetStyles = StyleSheet.create({ body: { flexGrow: 1, flexShrink: 1, minHeight: 0 } });

export function useIsolatedBottomSheetVisibility({
  visible,
  isEnabled,
  onClose,
  onBack,
}: {
  visible: boolean;
  isEnabled?: boolean;
  onClose: () => void;
  /** Offered Android Back before it closes the sheet; returns true when it handled the press. */
  onBack?: () => boolean;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  const tracker = useMemo(
    () =>
      createBottomSheetVisibilityTracker({
        onClose: () => onCloseRef.current(),
        backPress: systemBackPress,
        onBack: () => onBackRef.current?.() ?? false,
      }),
    [],
  );

  const setSheetRef = useCallback(
    (instance: IsolatedBottomSheetModalRef | null) => {
      tracker.attachController(instance as BottomSheetController | null);
    },
    [tracker],
  );

  const handleSheetChange = useCallback(
    (index: number) => tracker.handleSheetIndexChange(index),
    [tracker],
  );

  const handleSheetDismiss = useCallback(() => tracker.handleSheetDismiss(), [tracker]);

  useEffect(() => {
    tracker.syncDesired({ visible, isEnabled });
  }, [isEnabled, tracker, visible]);

  return {
    sheetRef: setSheetRef,
    handleSheetChange,
    handleSheetDismiss,
  };
}

export { SheetVisibleFrame } from "./visible-frame";
export { SheetFullBleedRegion, SheetFullBleedView, SheetScrollView } from "./full-bleed-view";
export { systemBackPress } from "./back-press";
export { SheetHostScope } from "./host-scope";
