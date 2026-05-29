// Evaluated by playwright-cli `run-code` in a Node `vm` context: file body
// MUST be a single arrow expression (no trailing `;`), MUST NOT use ES
// module syntax (`import`, `import.meta`), and file paths MUST be relative
// to the daemon CWD (= projectRoot via spawnSync cwd).
async (page) => {
  const baseUrl = "http://localhost:3098";
  const evidenceDir = ".sisyphus/evidence";
  const firstBody = [
    "T20 first saved parent.system prompt.",
    "Keep orchestration scoped to the issue.",
    "Record audit evidence for prompt edits.",
  ].join("\n");
  const secondBody = [
    "T20 second saved parent.system prompt.",
    "Keep orchestration scoped to the issue.",
    "Record diff rows for added and removed text.",
  ].join("\n");
  const requestedUrls = [];

  const assert = (condition, message) => {
    if (!condition) {
      throw new Error(message);
    }
  };

  const screenshot = async (step) => {
    await page.screenshot({
      path: `${evidenceDir}/task-20-step-${step}.png`,
      fullPage: true,
    });
  };

  const goto = async (path) => {
    await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  };

  const waitForCodeMirror = async () => {
    await page.locator(".cm-editor").waitFor({ state: "visible", timeout: 10000 });
  };

  const revisionIds = async () => {
    const texts = await page.locator("li").allTextContents();
    return texts
      .flatMap((text) => [...text.matchAll(/#(\d+)/g)].map((match) => Number(match[1])))
      .filter(Number.isFinite);
  };

  const editViaCodeMirror = async (body) => {
    await waitForCodeMirror();
    await page.locator(".cm-content").click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.insertText(body);
  };

  const submitSaveExpect302 = async (expectedUrl) => {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url() === `${baseUrl}/prompts/parent.system` &&
        response.request().method() === "POST" &&
        response.status() === 302,
      { timeout: 10000 },
    );
    const urlPromise = page.waitForURL(expectedUrl, { timeout: 10000 });
    await page
      .locator('form[action="/prompts/parent.system"] button')
      .filter({ hasText: "Save" })
      .click();
    const response = await responsePromise;
    await urlPromise;
    return response.status();
  };

  page.on("request", (request) => {
    requestedUrls.push(request.url());
  });

  await goto("/prompts");
  await page.locator("main").waitFor({ state: "visible", timeout: 5000 });
  for (const key of ["parent.system", "child.system", "parent.runtime", "child.runtime"]) {
    assert(
      (await page.getByRole("link", { name: key }).count()) === 1,
      `missing prompt key ${key}`,
    );
  }
  assert((await page.locator("text=editable").count()) >= 2, "editable badges not visible");
  assert((await page.locator("text=read-only").count()) >= 2, "read-only badges not visible");
  await screenshot(1);

  await goto("/prompts/parent.system");
  await waitForCodeMirror();
  assert((await page.locator(".cm-editor").count()) === 1, "CodeMirror did not initialize");
  await screenshot(2);

  await editViaCodeMirror(firstBody);
  assert(
    (await submitSaveExpect302(`${baseUrl}/prompts/parent.system`)) === 302,
    "first save was not a 302",
  );
  await waitForCodeMirror();
  assert(
    (await page.locator('textarea[name="body"]').inputValue()) === firstBody,
    "first saved body not visible",
  );
  await screenshot(3);

  const firstEditRevisionId = Math.max(...(await revisionIds()));
  assert(firstEditRevisionId > 1, "new edit revision missing from history");
  assert(
    (await page.getByText(`#${firstEditRevisionId}`, { exact: true }).count()) >= 1,
    `new revision #${firstEditRevisionId} missing from history`,
  );
  assert((await page.locator("text=edit").count()) >= 1, "edit source missing from history");
  await screenshot(4);

  assert(
    (await submitSaveExpect302(`${baseUrl}/prompts/parent.system?no_change=1`)) === 302,
    "identical save was not a 302",
  );
  assert(page.url().includes("?no_change=1"), "no_change query missing after identical submit");
  const noChangeBannerCount =
    (await page.locator(".prompt-no-changes-banner").count()) +
    (await page.locator("text=no new revision").count());
  assert(noChangeBannerCount >= 1, "no-change banner missing");
  await waitForCodeMirror();
  await screenshot(5);

  await editViaCodeMirror(secondBody);
  assert(
    (await submitSaveExpect302(`${baseUrl}/prompts/parent.system`)) === 302,
    "second save was not a 302",
  );
  await page.locator(".diff-add").first().waitFor({ state: "visible", timeout: 5000 });
  await page.locator(".diff-remove").first().waitFor({ state: "visible", timeout: 5000 });
  assert(
    (await page.locator('textarea[name="body"]').inputValue()) === secondBody,
    "second saved body not visible",
  );
  await screenshot(6);

  const restoreInput = `input[name="revision_id"][value="${firstEditRevisionId}"]`;
  await page.locator(restoreInput).waitFor({ state: "attached", timeout: 5000 });
  await screenshot(7);
  const restoreResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${baseUrl}/prompts/parent.system/restore` &&
      response.request().method() === "POST" &&
      response.status() === 302,
    { timeout: 10000 },
  );
  const restoreUrlPromise = page.waitForURL(`${baseUrl}/prompts/parent.system`, { timeout: 10000 });
  await page
    .locator(restoreInput)
    .locator("xpath=ancestor::form")
    .getByRole("button", { name: /restore/i })
    .click();
  assert((await restoreResponsePromise).status() === 302, "restore was not a 302");
  await restoreUrlPromise;
  await waitForCodeMirror();
  assert(
    (await page.locator('textarea[name="body"]').inputValue()) === firstBody,
    "restore did not revert to older body",
  );
  assert(
    (await page.locator("text=restore").count()) >= 1,
    "restore source row missing from history",
  );
  await screenshot(8);

  await goto("/prompts/parent.runtime");
  await page.locator("pre.prompt-readonly").waitFor({ state: "visible", timeout: 5000 });
  assert((await page.locator("form").count()) === 0, "read-only runtime page rendered a form");
  assert((await page.locator("text=read-only").count()) >= 1, "read-only banner missing");
  await screenshot(9);

  const forbiddenRequests = requestedUrls.filter((url) =>
    /api\.anthropic\.com|anthropic\.com\/v1|api\.github\.com/.test(url),
  );
  assert(
    forbiddenRequests.length === 0,
    `unexpected external API requests: ${forbiddenRequests.join(", ")}`,
  );

  return {
    screenshots: 9,
    firstSaveStatus: 302,
    identicalSaveStatus: 302,
    secondSaveStatus: 302,
    restoreStatus: 302,
    forbiddenRequests,
  }
}
