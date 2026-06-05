import { describe, expect, it } from "bun:test";
import { StopNoticePlaceholder, StopRunScript } from "../components/stop-run-script";

async function renderScriptBody(): Promise<string> {
  const html = String(await StopRunScript({}));
  const body = html.match(/<script[^>]*>([\s\S]*)<\/script>/)?.[1];
  if (!body) throw new Error("script body not found");
  return body;
}

/**
 * Minimal DOM/fetch harness so we can actually execute the inline script and
 * observe that a stop submit produces a notice — the original bug was that no
 * feedback appeared, so string-contains assertions alone are not enough.
 */
function createHarness(fetchImpl: (url: string, init: unknown) => Promise<unknown>) {
  const submitHandlers: Array<(event: { preventDefault(): void }) => unknown> = [];
  const button = { disabled: false, textContent: "stop this run" };
  const notice = {
    className: "",
    textContent: "",
    style: { display: "none" } as { display: string },
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
  };
  const form = {
    action: "https://dashboard.test/api/runs/run-1/stop",
    style: { display: "block" } as { display: string },
    querySelector: (selector: string) => (selector.includes("button") ? button : null),
    addEventListener: (_event: string, handler: (event: { preventDefault(): void }) => unknown) => {
      submitHandlers.push(handler);
    },
  };
  const document = {
    querySelectorAll: (selector: string) => (selector === "[data-stop-run-form]" ? [form] : []),
    querySelector: (selector: string) => (selector === "[data-stop-notice]" ? notice : null),
  };

  async function submit(): Promise<void> {
    let prevented = false;
    for (const handler of submitHandlers) {
      await handler({
        preventDefault() {
          prevented = true;
        },
      });
    }
    if (!prevented) throw new Error("submit was not intercepted");
  }

  return { button, document, fetchImpl, form, notice, submit };
}

async function runScript(harness: ReturnType<typeof createHarness>): Promise<void> {
  const body = await renderScriptBody();
  // Execute our own generated script under a stubbed DOM to observe its behaviour.
  const factory = new Function("document", "fetch", body);
  factory(harness.document, harness.fetchImpl);
}

describe("StopNoticePlaceholder", () => {
  it("renders a hidden notice element targeted by the stop script", async () => {
    const html = String(await StopNoticePlaceholder({}));

    expect(html).toContain("data-stop-notice");
    expect(html).toContain("display:none");
  });
});

describe("StopRunScript markup", () => {
  it("intercepts the stop form submit and posts via fetch instead of navigating", async () => {
    const html = String(await StopRunScript({}));

    expect(html).toContain("[data-stop-run-form]");
    expect(html).toContain("event.preventDefault()");
    expect(html).toContain("fetch(form.action");
    expect(html).toContain("'POST'");
  });

  it("embeds the localized feedback messages", async () => {
    const html = String(await StopRunScript({}));

    expect(html).toContain("Stopping the run. This may take a few seconds…");
    expect(html).toContain("The run has been stopped.");
    expect(html).toContain("This run has already finished.");
    expect(html).toContain("Stop request timed out. The run may not have stopped.");
    expect(html).toContain("Failed to request stop. Please try again.");
  });
});

describe("StopRunScript behaviour", () => {
  it("shows an immediate progress notice before the request resolves", async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    const harness = createHarness(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    await runScript(harness);

    // Do not await: the request is still pending here.
    const pending = harness.submit();
    expect(harness.notice.textContent).toBe("Stopping the run. This may take a few seconds…");
    expect(harness.notice.className).toContain("stop-notice-info");
    expect(harness.notice.style.display).toBe("block");
    expect(harness.button.disabled).toBe(true);
    expect(harness.button.textContent).toBe("Stopping…");

    resolveFetch?.({ ok: true, status: 200 });
    await pending;

    expect(harness.notice.textContent).toBe("The run has been stopped.");
  });

  it("shows a success notice and hides the form when the stop succeeds (200)", async () => {
    const harness = createHarness(async () => ({ ok: true, status: 200 }));
    await runScript(harness);
    await harness.submit();

    expect(harness.notice.style.display).toBe("block");
    expect(harness.notice.textContent).toBe("The run has been stopped.");
    expect(harness.notice.className).toContain("stop-notice-success");
    expect(harness.form.style.display).toBe("none");
  });

  it("shows an info notice when the run already finished (409)", async () => {
    const harness = createHarness(async () => ({ ok: false, status: 409 }));
    await runScript(harness);
    await harness.submit();

    expect(harness.notice.textContent).toBe("This run has already finished.");
    expect(harness.notice.className).toContain("stop-notice-info");
    expect(harness.form.style.display).toBe("none");
  });

  it("warns and re-enables the button on stop timeout (504)", async () => {
    const harness = createHarness(async () => ({ ok: false, status: 504 }));
    await runScript(harness);
    await harness.submit();

    expect(harness.notice.textContent).toBe(
      "Stop request timed out. The run may not have stopped.",
    );
    expect(harness.notice.className).toContain("stop-notice-error");
    expect(harness.notice.attributes.role).toBe("alert");
    expect(harness.button.disabled).toBe(false);
  });

  it("reports a failure and re-enables the button when fetch rejects", async () => {
    const harness = createHarness(() => Promise.reject(new Error("network down")));
    await runScript(harness);
    await harness.submit();

    expect(harness.notice.textContent).toBe("Failed to request stop. Please try again.");
    expect(harness.button.disabled).toBe(false);
    expect(harness.button.textContent).toBe("stop this run");
  });
});
