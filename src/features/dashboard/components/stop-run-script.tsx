/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { t } from "@/features/dashboard/i18n";

const NOTICE_BASE_CLASS = "p-4 rounded-lg border";

const NOTICE_VARIANTS = {
  success: "bg-success-50 text-success-900 border-success-200",
  error: "bg-danger-50 text-danger-900 border-danger-200",
  info: "bg-info-50 text-info-900 border-info-200",
} as const;

/**
 * Hidden notice element that the {@link StopRunScript} fills in after a stop
 * request resolves. Place it next to a stop form so feedback appears in context.
 */
export const StopNoticePlaceholder: FC = () => (
  <div data-stop-notice role="status" style={{ display: "none" }} />
);

function buildScriptContent(): string {
  const messages = {
    stopping: t("Stopping the run. This may take a few seconds…"),
    stopped: t("The run has been stopped."),
    alreadyTerminal: t("This run has already finished."),
    timeout: t("Stop request timed out. The run may not have stopped."),
    failed: t("Failed to request stop. Please try again."),
  };
  const stoppingLabel = t("Stopping…");
  // The stop endpoint replies with JSON, so a plain form POST would navigate the
  // browser to a raw JSON page. Intercept the submit and surface the outcome in
  // an inline banner instead. The cancel endpoint waits for the run to actually
  // stop, so the response can take a few seconds — show an immediate "stopping"
  // notice so the page does not look frozen, then report the final outcome,
  // distinguishing success / already-terminal (409) / timeout (504).
  return `
(function() {
  const baseClass = ${JSON.stringify(NOTICE_BASE_CLASS)};
  const variants = ${JSON.stringify(NOTICE_VARIANTS)};
  const messages = ${JSON.stringify(messages)};
  const stoppingLabel = ${JSON.stringify(stoppingLabel)};
  const forms = document.querySelectorAll('[data-stop-run-form]');

  forms.forEach((form) => {
    const notice = document.querySelector('[data-stop-notice]');
    const button = form.querySelector('button[type="submit"]');
    const originalLabel = button ? button.textContent : '';

    function showNotice(kind, message) {
      if (!notice) return;
      notice.className = baseClass + ' ' + variants[kind] + ' stop-notice-' + kind;
      notice.textContent = message;
      notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      notice.style.display = 'block';
    }

    function resetButton() {
      if (!button) return;
      button.disabled = false;
      button.textContent = originalLabel;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (button) {
        button.disabled = true;
        button.textContent = stoppingLabel;
      }
      // Immediate progress feedback: the request may take a few seconds.
      showNotice('info', messages.stopping);

      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });

        if (response.ok) {
          showNotice('success', messages.stopped);
          form.style.display = 'none';
        } else if (response.status === 409) {
          showNotice('info', messages.alreadyTerminal);
          form.style.display = 'none';
        } else if (response.status === 504) {
          showNotice('error', messages.timeout);
          resetButton();
        } else {
          showNotice('error', messages.failed);
          resetButton();
        }
      } catch (_error) {
        showNotice('error', messages.failed);
        resetButton();
      }
    });
  });
})();
`;
}

export const StopRunScript: FC = () => (
  <script type="module" dangerouslySetInnerHTML={{ __html: buildScriptContent() }} />
);
