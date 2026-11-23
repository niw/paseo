import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  withAcpStreamingMarkdown,
  requestAcpMarkdown,
  expectAcpMarkdown,
  reloadAcpMarkdown,
} from "../support/helpers/acp-streaming-markdown";
import {
  expectFinishedMarkdown,
  expectReloadedMarkdown,
  expectUnfinishedBold,
  expectUnfinishedLink,
  requestStreamingMarkdown,
  withStreamingMarkdown,
} from "../support/helpers/streaming-markdown";

test("formats unfinished Markdown while streaming and preserves the completed rendering", async ({
  page,
}, testInfo) => {
  await withStreamingMarkdown(page, testInfo, async (agent) => {
    await requestStreamingMarkdown(agent);
    await expectUnfinishedBold(page);
    await expectUnfinishedLink(page, agent, testInfo);
    await expectFinishedMarkdown(page, agent, testInfo);
    await expectReloadedMarkdown(page);
  });
});

test("opens a Visualize reference inline and retries a missing host file", async ({ page }) => {
  await page.setViewportSize({ width: 1620, height: 1000 });
  const directory = await mkdtemp(join(tmpdir(), "paseo-visualize-"));
  const figure = join(directory, "図 [1].html");
  const missing = join(directory, "missing.html");
  const html = `<div id="figure">
    <button id="update" type="button">更新</button>
    <output id="value">初期値</output>
    <script>
      document.getElementById('update').onclick = () => {
        document.getElementById('value').textContent = '更新済み';
      };
    </script>
  </div>`;
  try {
    await writeFile(figure, html);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "visualize-markdown-",
      title: "Visualize Markdown",
      featureValues: {
        mockStreamingAssistantResponse: [
          "**Before the figure**",
          `\uE200visualize\uE202${JSON.stringify({ path: figure, mode: "wide", title: "図のタイトル" })}\uE201`,
          "After the figure",
          `\uE200visualize\uE202${JSON.stringify({ path: missing })}\uE201`,
        ].join("\n"),
        mockStreamingAssistantIntervalMs: 1,
      },
    });
    try {
      await openAgentRoute(page, agent);
      await agent.client.sendAgentMessage(agent.agentId, "Show the Visualize references.");
      await agent.client.waitForFinish(agent.agentId, 30_000);
      const message = page.getByTestId("assistant-message").last();
      const blocks = message.getByTestId("visualize-block");
      await expect(blocks).toHaveCount(2);
      await expect(message.locator("strong")).toHaveText("Before the figure");
      await expect(message).toContainText("After the figure");
      await expect(message).not.toContainText("\uE200");
      await expect(blocks.first()).toHaveCSS("max-width", "1024px");
      await expect(blocks.first()).toHaveCSS("width", "1024px");
      await expect(blocks.first()).toContainText("図のタイトル");
      await expect(message.getByTestId("visualize-preview")).toHaveCount(0);
      await blocks.first().getByRole("button", { name: "Preview" }).click();
      await expect(blocks.first().getByTestId("visualize-preview")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      );
      const frame = blocks.first().frameLocator('[title="図のタイトル"]');
      await expect(frame.locator("output")).toHaveText("初期値");
      await frame.getByRole("button", { name: "更新" }).click();
      await expect(frame.locator("output")).toHaveText("更新済み");
      await blocks.first().getByRole("button", { name: "Close" }).click();
      await expect(message.getByTestId("visualize-preview")).toHaveCount(0);

      const missingBlock = blocks.last();
      await missingBlock.getByRole("button", { name: "Preview" }).click();
      await expect(missingBlock.getByText("Failed to load file preview")).toBeVisible();
      await writeFile(missing, '<div id="figure">Recovered figure</div>');
      await missingBlock.getByRole("button", { name: "Retry" }).click();
      await expect(
        missingBlock.frameLocator('[title="Visualize"]').getByText("Recovered figure"),
      ).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const width of [1100, 390]) {
  test(`ACP plugin chunks preserve Markdown and separate turns at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await withAcpStreamingMarkdown(page, async (agent) => {
      await requestAcpMarkdown(agent);
      await expectAcpMarkdown(page, 1);
      await requestAcpMarkdown(agent);
      await expectAcpMarkdown(page, 2);
      await reloadAcpMarkdown(page, testInfo);
    });
  });
}
