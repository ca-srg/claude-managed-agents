import { t } from "@/features/dashboard/i18n";

export function packageListEnhanceScript(): string {
  const addPackagePlaceholder = t("Add package");
  const addPackageAriaLabel = t("Add package spec");
  const removeLabelTemplate = t("Remove {name}");
  const invalidPackageMessage = t("Package specs must be 1-200 characters with no whitespace.");

  return `
(() => {
  const ADD_PACKAGE_PLACEHOLDER = ${JSON.stringify(addPackagePlaceholder)};
  const ADD_PACKAGE_ARIA_LABEL = ${JSON.stringify(addPackageAriaLabel)};
  const REMOVE_LABEL_TEMPLATE = ${JSON.stringify(removeLabelTemplate)};
  const INVALID_PACKAGE_MESSAGE = ${JSON.stringify(invalidPackageMessage)};
  const CONTAINER_SELECTOR = "[data-pkg-list-container]";
  const INPUT_SELECTOR = "textarea[data-pkg-list-input]";
  const CHIP_CLASS = "inline-flex items-center gap-1 rounded-md border border-brand-200 bg-brand-50 px-2 py-1 font-mono text-xs font-medium text-brand-700";
  const REMOVE_CLASS = "ml-1 rounded text-brand-600 hover:text-danger-700 focus:outline-none focus:ring-2 focus:ring-brand-500/30";
  const EDITOR_CLASS = "package-list-chip-editor flex min-h-10 flex-wrap items-center gap-2 rounded-md border border-neutral-300 bg-surface px-3 py-2 shadow-sm focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20";
  const INLINE_INPUT_CLASS = "min-w-32 flex-1 border-0 bg-transparent p-1 font-mono text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none";
  const MESSAGE_CLASS = "min-h-4 text-xs text-danger-700";
  const WHITESPACE_PATTERN = /\\s/;

  function parseValues(value) {
    return value
      .split(/[\\r\\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function isValidPackageSpec(value) {
    return value.length > 0 && value.length <= 200 && !WHITESPACE_PATTERN.test(value);
  }

  function enhanceContainer(container) {
    if (!(container instanceof HTMLElement)) return;
    if (container.dataset.pkgListEnhanced === "true") return;

    const textarea = container.querySelector(INPUT_SELECTOR);
    if (!(textarea instanceof HTMLTextAreaElement)) return;

    container.dataset.pkgListEnhanced = "true";

    const chips = parseValues(textarea.value).filter(isValidPackageSpec);
    const editor = document.createElement("div");
    const inlineInput = document.createElement("input");
    const message = document.createElement("p");
    let messageTimer = 0;

    editor.className = EDITOR_CLASS;
    editor.setAttribute("role", "group");
    editor.setAttribute(
      "aria-label",
      textarea.getAttribute("aria-label") || textarea.name + " package specs",
    );
    editor.addEventListener("click", () => inlineInput.focus());

    inlineInput.type = "text";
    inlineInput.autocomplete = "off";
    inlineInput.className = INLINE_INPUT_CLASS;
    inlineInput.placeholder = textarea.getAttribute("placeholder") || ADD_PACKAGE_PLACEHOLDER;
    inlineInput.setAttribute("aria-label", ADD_PACKAGE_ARIA_LABEL);

    message.className = MESSAGE_CLASS;
    message.setAttribute("aria-live", "polite");

    function syncTextarea() {
      textarea.value = chips.join("\\n");
    }

    function showMessage(text) {
      message.textContent = text;
      if (messageTimer !== 0) window.clearTimeout(messageTimer);
      messageTimer = window.setTimeout(() => {
        message.textContent = "";
        messageTimer = 0;
      }, 3000);
    }

    function render() {
      editor.textContent = "";

      chips.forEach((chip, index) => {
        const chipEl = document.createElement("span");
        const label = document.createElement("span");
        const remove = document.createElement("button");

        chipEl.className = CHIP_CLASS;
        label.textContent = chip;
        remove.type = "button";
        remove.className = REMOVE_CLASS;
        remove.textContent = "×";
        remove.setAttribute("aria-label", REMOVE_LABEL_TEMPLATE.replace("{name}", chip));
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          chips.splice(index, 1);
          render();
          inlineInput.focus();
        });

        chipEl.append(label, remove);
        editor.appendChild(chipEl);
      });

      editor.appendChild(inlineInput);
      syncTextarea();
    }

    function addRawValue(rawValue) {
      const candidates = parseValues(rawValue);
      let rejected = 0;

      candidates.forEach((candidate) => {
        if (!isValidPackageSpec(candidate)) {
          rejected += 1;
          return;
        }

        if (!chips.includes(candidate)) {
          chips.push(candidate);
        }
      });

      inlineInput.value = "";
      render();

      if (rejected > 0) {
        showMessage(INVALID_PACKAGE_MESSAGE);
      }
    }

    inlineInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        addRawValue(inlineInput.value);
        return;
      }

      if (event.key === "Backspace" && inlineInput.value === "" && chips.length > 0) {
        chips.pop();
        render();
      }
    });

    inlineInput.addEventListener("paste", (event) => {
      const text = event.clipboardData ? event.clipboardData.getData("text") : "";
      if (text === "") return;
      event.preventDefault();
      addRawValue(text);
    });

    inlineInput.addEventListener("blur", () => {
      if (inlineInput.value.trim() !== "") {
        addRawValue(inlineInput.value);
      }
    });

    const form = textarea.closest("form");
    if (form) {
      form.addEventListener("submit", syncTextarea);
    }

    textarea.before(editor, message);
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    textarea.tabIndex = -1;
    textarea.setAttribute("aria-hidden", "true");
    render();
  }

  function enhanceAll() {
    document.querySelectorAll(CONTAINER_SELECTOR).forEach(enhanceContainer);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enhanceAll, { once: true });
  } else {
    enhanceAll();
  }
})();
`.trim();
}

export const PACKAGE_LIST_ENHANCE_SCRIPT = packageListEnhanceScript();
