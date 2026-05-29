// Evaluated by playwright-cli `run-code` in a Node `vm` context: file body
// MUST be a single arrow expression (no trailing `;`), MUST NOT use ES
// module syntax (`import`, `import.meta`), and file paths MUST be relative
// to the daemon CWD (= projectRoot via spawnSync cwd).
async (page) => {
  const baseUrl = "http://localhost:3098";
  const evidencePath = ".sisyphus/evidence/task-20-degradation.png";
  const fallbackBody = [
    "T20 child.system fallback prompt.",
    "CodeMirror CDN is intentionally blocked.",
    "Textarea editing still persists the prompt body.",
  ].join("\n");

  const assert = (condition, message) => {
    if (!condition) {
      throw new Error(message);
    }
  };

  await page.goto(`${baseUrl}/prompts/child.system`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  assert(
    (await page.locator(".cm-editor").count()) === 0,
    "CodeMirror initialized despite esm.sh block",
  );
  await page.locator('textarea[name="body"]').waitFor({ state: "visible", timeout: 5000 });
  assert(
    await page.locator('textarea[name="body"]').isVisible(),
    "fallback textarea is not visible",
  );

  await page.locator('textarea[name="body"]').fill(fallbackBody);
  const saveResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${baseUrl}/prompts/child.system` &&
      response.request().method() === "POST" &&
      response.status() === 302,
    { timeout: 10000 },
  );
  const urlPromise = page.waitForURL(`${baseUrl}/prompts/child.system`, { timeout: 10000 });
  await page
    .locator('form[action="/prompts/child.system"] button')
    .filter({ hasText: "Save" })
    .click();
  assert((await saveResponsePromise).status() === 302, "fallback save was not a 302");
  await urlPromise;
  await page.waitForTimeout(1500);
  assert(
    (await page.locator(".cm-editor").count()) === 0,
    "CodeMirror initialized after fallback save",
  );
  await page.locator('textarea[name="body"]').waitFor({ state: "visible", timeout: 5000 });
  assert(
    (await page.locator('textarea[name="body"]').inputValue()) === fallbackBody,
    "fallback saved body not visible",
  );
  await page.screenshot({ path: evidencePath, fullPage: true })

  return { screenshot: evidencePath, saveStatus: 302, fallbackVisible: true }
}
