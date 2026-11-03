/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectHoverCard } from "./project-hover-card";

vi.mock("react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native")>()),
  View: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
}));

// Hover cannot be simulated here, so the card renders its content next to the row.
vi.mock("@/components/ui/hover-card", () => ({
  HoverCard: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  HoverCardTrigger: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  HoverCardContent: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
}));

vi.mock("@/components/ui/press-highlight", () => ({
  PressHighlight: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));

describe("ProjectHoverCard", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
  });

  function directoryTexts(projectKey: string): string[] {
    return Array.from(
      container?.querySelectorAll(`[data-testid="project-hover-card-directory-${projectKey}"]`) ??
        [],
    ).map((element) => element.textContent ?? "");
  }

  it("tells projects with the same name apart by their directories", () => {
    act(() => {
      root?.render(
        <>
          <ProjectHoverCard projectName="app" directories={["/work/one/app"]} projectKey="one">
            <span />
          </ProjectHoverCard>
          <ProjectHoverCard projectName="app" directories={["/work/two/app"]} projectKey="two">
            <span />
          </ProjectHoverCard>
        </>,
      );
    });

    expect(directoryTexts("one")).toEqual(["/work/one/app"]);
    expect(directoryTexts("two")).toEqual(["/work/two/app"]);
  });

  it("lists each distinct host directory once", () => {
    act(() => {
      root?.render(
        <ProjectHoverCard
          projectName="app"
          directories={["/home/me/app", "/home/me/app", "", "/srv/app"]}
          projectKey="app"
        >
          <span />
        </ProjectHoverCard>,
      );
    });

    expect(directoryTexts("app")).toEqual(["~/app", "/srv/app"]);
  });

  it("renders the row alone when the project has no directory", () => {
    act(() => {
      root?.render(
        <ProjectHoverCard projectName="app" directories={[""]} projectKey="app">
          <span data-testid="row" />
        </ProjectHoverCard>,
      );
    });

    expect(container?.querySelector('[data-testid="row"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="project-hover-card-app"]')).toBeNull();
  });
});
