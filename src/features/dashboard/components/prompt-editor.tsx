import type { FC } from "hono/jsx";
import { t } from "@/features/dashboard/i18n";

export type PromptEditorProps = {
  body: string;
  editable: boolean;
};

const PROMPT_EDITOR_BOOT_SCRIPT = `
(async () => {
  try {
    const wrapper = document.querySelector("[data-prompt-editor]");
    if (!wrapper) return;
    const textarea = wrapper.querySelector('textarea[name="body"]');
    if (!textarea) return;

    const cm = await import("https://esm.sh/codemirror@6.0.1?bundle");
    if (!cm || !cm.EditorView) return;

    const editor = new cm.EditorView({
      doc: textarea.value,
      parent: wrapper,
    });

    // Hide the textarea visually but keep it in the DOM so the form submits its value
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    textarea.tabIndex = -1;

    // Sync editor content to textarea before form submit
    const form = textarea.closest("form");
    if (form) {
      form.addEventListener("submit", () => {
        textarea.value = editor.state.doc.toString();
      });
    }
  } catch (err) {
    // Silently degrade — textarea is already visible and functional
    console.warn("prompt editor: progressive enhancement failed", err);
  }
})();
`.trim();

export const PromptEditor: FC<PromptEditorProps> = ({ body, editable }) => {
  if (!editable) {
    return (
      <pre class="prompt-readonly font-mono text-sm bg-surface-muted border border-neutral-200 rounded-md p-4 whitespace-pre-wrap overflow-x-auto max-h-[36rem] overflow-y-auto">
        {body}
      </pre>
    );
  }
  return (
    <div
      class="prompt-editor-wrapper border border-neutral-200 rounded-md overflow-hidden focus-within:ring-2 focus-within:ring-brand-500 focus-within:border-brand-500"
      data-prompt-editor
    >
      <textarea
        name="body"
        class="prompt-editor-fallback-textarea font-mono text-sm bg-surface-muted border-neutral-200 rounded-md p-3 w-full focus:outline-none focus:ring-2 focus:ring-brand-500"
        required
        minlength={10}
        maxlength={102400}
        aria-label={t("prompt body")}
      >
        {body}
      </textarea>
      <script type="module" dangerouslySetInnerHTML={{ __html: PROMPT_EDITOR_BOOT_SCRIPT }} />
    </div>
  );
};
