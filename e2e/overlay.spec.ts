import { expect, test } from "@playwright/test";

test("overlay renders transparent chat surface and accepts test messages", async ({ page }) => {
  await page.goto("/overlay");
  await page.request.post("/api/settings", { data: { backgroundOpacity: 0.3, fontSize: 24 } });
  await page.evaluate(() => {
    window.dispatchEvent(new Event("resize"));
  });
  await page.request.post("/api/providers/chzzk/disconnect");
  await page.goto("/admin");
  await page.getByPlaceholder("오버레이 테스트 메시지").fill("Playwright overlay check");
  await page.getByRole("button", { name: "보내기" }).click();
  await page.goto("/overlay");

  await expect(page.getByText("Playwright overlay check").first()).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("admin exposes SOOP public chat connection", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "SOOP" }).click();

  await expect(page.getByText("공개 수신 모드")).toBeVisible();
  await expect(page.getByPlaceholder("예: phonics1 또는 https://play.sooplive.co.kr/phonics1")).toBeVisible();
});

test("dashboard renders live analytics and excludes mock messages", async ({ page }) => {
  await page.request.post("/api/analytics/live/reset");
  await page.goto("/admin");
  await page.getByPlaceholder("오버레이 테스트 메시지").fill("Dashboard mock exclusion");
  await page.getByRole("button", { name: "보내기" }).click();

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "채팅 분석 대시보드" })).toBeVisible();
  await expect(page.locator(".metric-tile").filter({ hasText: "메시지" })).toContainText("0");
  await expect(page.getByText("표시할 채팅이 없습니다.")).toBeVisible();
});

test("dashboard switches analytics window and shows timeline hover details", async ({ page }) => {
  await page.route(/\/api\/analytics\/live\?windowSec=1$/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: 1_720_000_002_000,
        windowSec: 1,
        totalMessages: 6,
        uniqueChatters: 3,
        providerCounts: { chzzk: 6 },
        roleCounts: { viewer: 6 },
        topChatters: [{ label: "테스터", count: 4 }],
        topTerms: [{ label: "분석", count: 3 }],
        topEmotes: [],
        recentMessages: [],
        windows: [
          {
            windowStart: 1_720_000_000_000,
            windowEnd: 1_720_000_001_000,
            messageCount: 4,
            uniqueChatters: 2,
            avgLength: 6,
            maxLength: 12,
            providerCounts: { chzzk: 4 },
            roleCounts: { viewer: 4 },
            topChatters: [],
            topTerms: [],
            topEmotes: []
          },
          {
            windowStart: 1_720_000_001_000,
            windowEnd: 1_720_000_002_000,
            messageCount: 2,
            uniqueChatters: 1,
            avgLength: 5,
            maxLength: 8,
            providerCounts: { chzzk: 2 },
            roleCounts: { viewer: 2 },
            topChatters: [],
            topTerms: [],
            topEmotes: []
          }
        ]
      })
    });
  });

  await page.goto("/dashboard");
  await page.getByRole("tab", { name: "1초" }).click();

  await expect(page.getByRole("heading", { name: "1초 윈도우" })).toBeVisible();
  await page.locator(".timeline-chart rect").first().hover();
  await expect(page.locator(".timeline-tooltip")).toContainText("메시지 4개");
  await expect(page.locator(".timeline-tooltip")).toContainText("참여자 2명");
});

test("dashboard lets users drag window ranges and save highlight memos", async ({ page }) => {
  const startAt = 1_720_000_000_000;
  const windowMs = 5_000;
  const windows = Array.from({ length: 80 }, (_, index) => ({
    windowStart: startAt + index * windowMs,
    windowEnd: startAt + (index + 1) * windowMs,
    messageCount: index === 20 ? 42 : index === 21 ? 30 : 2,
    uniqueChatters: index === 20 ? 39 : index === 21 ? 24 : 1,
    avgLength: 5,
    maxLength: 12,
    providerCounts: { chzzk: index === 20 ? 42 : index === 21 ? 30 : 2 },
    roleCounts: { viewer: index === 20 ? 42 : index === 21 ? 30 : 2 },
    topChatters: [],
    topTerms: index === 20 ? [{ label: "펜타킬", count: 14 }] : [],
    topEmotes: []
  }));
  const selectedStartAt = windows[20].windowStart;
  const selectedEndAt = windows[21].windowEnd;
  const candidateId = `session-1-5-${selectedStartAt}-${selectedEndAt}`;

  await page.route(/\/api\/analytics\/live\?windowSec=5$/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: startAt,
        windowSec: 5,
        totalMessages: windows.reduce((sum, window) => sum + window.messageCount, 0),
        uniqueChatters: 39,
        providerCounts: { chzzk: windows.reduce((sum, window) => sum + window.messageCount, 0) },
        roleCounts: { viewer: windows.reduce((sum, window) => sum + window.messageCount, 0) },
        topChatters: [],
        topTerms: [{ label: "펜타킬", count: 14 }],
        topEmotes: [],
        recentMessages: [],
        windows
      })
    });
  });

  await page.route(/\/api\/analytics\/live\/highlights\?windowSec=5$/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: startAt,
        windowSec: 5,
        session: {
          sessionId: "session-1",
          provider: "chzzk",
          sourceMode: "unofficial",
          channelId: "N2aiJi",
          startedAt: startAt,
          messageCount: 42,
          fileName: "session-1.jsonl"
        },
        canSaveAnnotations: true,
        thresholds: {
          activeWindowMean: 10,
          p95: 30,
          p99: 40,
          max: 42,
          windowCount: 1,
          activeWindowCount: 1,
          candidateWindowCount: 1
        },
        candidates: [],
        annotations: {}
      })
    });
  });

  await page.route(/\/api\/analytics\/sessions\/session-1\/annotations\/.+$/, async (route) => {
    const body = route.request().postDataJSON() as { category: string; note: string; startAt: number; endAt: number; windowSec: number };
    expect(body).toMatchObject({
      category: "pentakill",
      note: "펜타킬 장면",
      startAt: selectedStartAt,
      endAt: selectedEndAt,
      windowSec: 5
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "session-1",
        annotation: {
          candidateId,
          category: "pentakill",
          note: "펜타킬 장면",
          startAt: selectedStartAt,
          endAt: selectedEndAt,
          windowSec: 5,
          createdAt: startAt,
          updatedAt: startAt
        }
      })
    });
  });

  await page.goto("/dashboard");

  await expect(page.getByRole("heading", { name: "하이라이트 메모" })).toBeVisible();
  await expect(page.locator(".timeline-scrollbar input")).toHaveValue("20");
  const firstBar = page.locator(".timeline-chart rect").first();
  const secondBar = page.locator(".timeline-chart rect").nth(1);
  const firstBox = await firstBar.boundingBox();
  const secondBox = await secondBar.boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  if (!firstBox || !secondBox) {
    throw new Error("timeline bars were not rendered");
  }
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await page.mouse.up();
  await expect(page.getByText("펜타킬 14")).toBeVisible();
  await page.locator(".highlight-row select").selectOption("pentakill");
  await page.getByPlaceholder("어떤 하이라이트였는지 메모").fill("펜타킬 장면");
  await page.locator(".highlight-row").getByRole("button", { name: "저장" }).click();
  await expect(page.locator(".highlight-row").getByRole("button")).toContainText("저장됨");
  await expect(page.locator(".saved-memo-row")).toContainText("펜타킬 장면");
});
