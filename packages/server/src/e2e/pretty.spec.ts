/**
 * Pretty-print step card toggle — E2E coverage.
 *
 * Covers the seven scenarios in the test diagram of the pretty-print
 * plan: toggle flips all 4 bodies, double-toggle reverts, reload
 * restores via localStorage, per-step isolation, live-appended card
 * honors localStorage, keyboard accessibility, and graceful degradation
 * when localStorage is unavailable.
 *
 * Fixture: see ./serve-fixture.ts — boots a real meter server against a
 * temp METERBILITY_HOME, seeds a run with two pre-rendered steps (seq 0 + 1),
 * and exposes POST /__test__/append-step to append a third (seq 2) via
 * the live SSE pipe.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

type Fixture = { port: number; host: string; runId: string };

function loadFixture(): Fixture {
  const path = join(
    fileURLToPath(new URL("./", import.meta.url)),
    "fixture.json",
  );
  return JSON.parse(readFileSync(path, "utf-8")) as Fixture;
}

const FIXTURE = loadFixture();
const RUN_URL = `/runs/${FIXTURE.runId}`;
// Step IDs are deterministic — see serve-fixture.ts buildStep().
const STEP_0 = "stp-e2e-0";
const STEP_1 = "stp-e2e-1";
const STEP_2 = "stp-e2e-2";

/** Helper: count tab bodies whose effective display style matches. */
async function countVisibleBodies(
  page: Page,
  stepId: string,
  kind: "raw" | "pretty",
): Promise<number> {
  return page.evaluate(
    ({ stepId, kind }) => {
      const card = document.querySelector(`.step-card[data-step="${stepId}"]`);
      if (!card) return -1;
      const bodies = card.querySelectorAll(`pre.body.${kind}`);
      let n = 0;
      bodies.forEach((el) => {
        const style = (el as HTMLElement).style.display;
        // raw is visible when display is not "none"; pretty is visible
        // when display is unset/empty (we strip the inline `none` on
        // toggle-on). Mirror what togglePretty/applyPrettyState do.
        if (style !== "none") n++;
      });
      return n;
    },
    { stepId, kind },
  );
}

async function buttonPressed(page: Page, stepId: string): Promise<string | null> {
  return page.evaluate((stepId) => {
    const card = document.querySelector(`.step-card[data-step="${stepId}"]`);
    return card?.querySelector(".pretty-toggle")?.getAttribute("aria-pressed") ?? null;
  }, stepId);
}

test.describe("pretty-print toggle", () => {
  test("clicking the toggle flips all 4 tab bodies for that step", async ({
    page,
  }) => {
    await page.goto(RUN_URL);
    // Baseline: 4 raw bodies visible, 0 pretty bodies visible.
    expect(await countVisibleBodies(page, STEP_0, "raw")).toBe(4);
    expect(await countVisibleBodies(page, STEP_0, "pretty")).toBe(0);
    expect(await buttonPressed(page, STEP_0)).toBe("false");

    await page
      .locator(`.step-card[data-step="${STEP_0}"] .pretty-toggle`)
      .click();

    expect(await countVisibleBodies(page, STEP_0, "raw")).toBe(0);
    expect(await countVisibleBodies(page, STEP_0, "pretty")).toBe(4);
    expect(await buttonPressed(page, STEP_0)).toBe("true");
  });

  test("clicking the toggle twice reverts to raw", async ({ page }) => {
    await page.goto(RUN_URL);
    const toggle = page.locator(
      `.step-card[data-step="${STEP_0}"] .pretty-toggle`,
    );
    await toggle.click();
    await toggle.click();
    expect(await countVisibleBodies(page, STEP_0, "raw")).toBe(4);
    expect(await countVisibleBodies(page, STEP_0, "pretty")).toBe(0);
    expect(await buttonPressed(page, STEP_0)).toBe("false");
    // localStorage key should be cleared, not just left dangling.
    const stored = await page.evaluate(
      ([runId, stepId]) =>
        localStorage.getItem(`meter:pretty:${runId}:${stepId}`),
      [FIXTURE.runId, STEP_0],
    );
    expect(stored).toBeNull();
  });

  test("toggle persists across reload via localStorage", async ({ page }) => {
    await page.goto(RUN_URL);
    await page
      .locator(`.step-card[data-step="${STEP_0}"] .pretty-toggle`)
      .click();
    expect(await buttonPressed(page, STEP_0)).toBe("true");

    await page.reload();

    // After reload, restorePrettyForCard runs on DOMContentLoaded and
    // re-applies pretty mode based on the localStorage key.
    expect(await buttonPressed(page, STEP_0)).toBe("true");
    expect(await countVisibleBodies(page, STEP_0, "pretty")).toBe(4);
    expect(await countVisibleBodies(page, STEP_0, "raw")).toBe(0);
  });

  test("toggling step A leaves step B in raw mode", async ({ page }) => {
    await page.goto(RUN_URL);
    await page
      .locator(`.step-card[data-step="${STEP_0}"] .pretty-toggle`)
      .click();
    expect(await buttonPressed(page, STEP_0)).toBe("true");
    expect(await buttonPressed(page, STEP_1)).toBe("false");
    expect(await countVisibleBodies(page, STEP_1, "raw")).toBe(4);
    expect(await countVisibleBodies(page, STEP_1, "pretty")).toBe(0);
  });

  test("live-appended step card honors a pre-set localStorage key", async ({
    page,
    request,
  }) => {
    await page.goto(RUN_URL);
    // Pre-seed localStorage for the step that hasn't been appended yet.
    // When the live-append code path mounts it, restorePrettyForCard
    // should immediately flip it to pretty before any user interaction.
    await page.evaluate(
      ([runId, stepId]) =>
        localStorage.setItem(`meter:pretty:${runId}:${stepId}`, "1"),
      [FIXTURE.runId, STEP_2],
    );

    // The live-run-updates handler only opens its EventSource when the
    // page is in live mode. We flip the meta tag + fire the same
    // CustomEvent the Live toggle button dispatches, which triggers
    // `maybeSubscribe(true)` inside `initLiveRunUpdates`. No need to
    // actually start LiveInspector — our test route fires SSE events
    // directly via the controller's subscriber set.
    await page.evaluate(() => {
      const meta = document.querySelector('meta[name="meter-live-mode"]');
      meta?.setAttribute("content", "1");
      document.dispatchEvent(
        new CustomEvent("meter:live-state", { detail: { live: true } }),
      );
    });

    // Wait for the SSE handshake to complete before firing the append.
    // The server only writes events to subscribers that have already
    // called `controller.on("data", …)` inside the stream handler — if
    // we POST too early the event is dropped on the floor.
    await page.waitForFunction(
      async () => {
        const res = await fetch("/api/live/status");
        return res.ok;
      },
      undefined,
      { timeout: 5000 },
    );
    // The previous fetch only confirms the route is up. The actual
    // subscriber registration happens inside the streaming handler;
    // a brief tick gives the client's EventSource time to connect.
    await page.waitForTimeout(250);

    // Append seq=2 server-side; the bootstrap's test route fires the
    // run:updated SSE event that the page's appendStepsUpTo listens for.
    const res = await request.post("/__test__/append-step");
    expect(res.ok()).toBeTruthy();

    // Wait for the new card to mount in the DOM.
    await page
      .locator(`.step-card[data-step="${STEP_2}"]`)
      .waitFor({ state: "attached", timeout: 5000 });

    // The freshly-inserted card should already be in pretty mode.
    expect(await buttonPressed(page, STEP_2)).toBe("true");
    expect(await countVisibleBodies(page, STEP_2, "pretty")).toBe(4);
    expect(await countVisibleBodies(page, STEP_2, "raw")).toBe(0);
  });

  test("pretty toggle is keyboard-accessible (Tab + Enter)", async ({
    page,
  }) => {
    await page.goto(RUN_URL);
    const toggle = page.locator(
      `.step-card[data-step="${STEP_0}"] .pretty-toggle`,
    );
    // The button is a real <button>, so it's tab-reachable. Focus it
    // directly (test stays robust to upstream layout changes that might
    // reshuffle the tab order) and confirm Enter activates it.
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await buttonPressed(page, STEP_0)).toBe("true");
    expect(await countVisibleBodies(page, STEP_0, "pretty")).toBe(4);
  });

  test("toggle still works in-session when localStorage throws", async ({
    page,
  }) => {
    await page.goto(RUN_URL);
    // Simulate a strict-privacy / disabled-storage environment by making
    // setItem throw. The togglePretty try/catch should swallow it and
    // still flip the DOM state for the current session.
    await page.evaluate(() => {
      const proto = Object.getPrototypeOf(window.localStorage) as Storage;
      const original = proto.setItem;
      // Patch on the instance so the prototype stays clean for other tests.
      (window.localStorage as unknown as { setItem: typeof original }).setItem =
        function () {
          throw new Error("storage disabled");
        };
      // Stash so we can restore after.
      (window as unknown as { __origSetItem?: typeof original }).__origSetItem =
        original;
    });

    await page
      .locator(`.step-card[data-step="${STEP_0}"] .pretty-toggle`)
      .click();

    expect(await buttonPressed(page, STEP_0)).toBe("true");
    expect(await countVisibleBodies(page, STEP_0, "pretty")).toBe(4);
  });
});
