/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { t } from "@/features/dashboard/i18n";

export type RunLiveScriptProps = {
  runId: string;
};

function buildScriptContent(runId: string): string {
  const failedParseMessage = t("Failed to parse live event payload");
  // NOTE: `<script type="module">` では `document.currentScript` が null になる仕様のため、
  // runId をスクリプト本体にテンプレート展開して読み込む。
  return `
(function() {
  const runId = ${JSON.stringify(runId)};
  if (!runId) return;

  const es = new EventSource('/api/runs/' + encodeURIComponent(runId) + '/events');

  const phaseElements = document.querySelectorAll('[data-phase]');
  const subIssuesList = document.getElementById('sub-issues-list');
  const subIssueTemplate = document.getElementById('sub-issue-template');
  const liveLogList = document.getElementById('live-log-list');
  const stopButtonForm = document.getElementById('stop-button-form');
  const statusBadge = document.getElementById('run-status-badge');
  const prUrlContainer = document.getElementById('pr-url-container');
  const prUrlLink = document.getElementById('pr-url-link');
  const errorBanner = document.getElementById('error-banner');
  const errorBannerMessage = document.getElementById('error-banner-message');

  function updatePhases(currentPhase) {
    let foundCurrent = false;
    phaseElements.forEach(el => {
      const phase = el.getAttribute('data-phase');
      if (phase === currentPhase) {
        el.setAttribute('data-active', 'true');
        el.removeAttribute('data-completed');
        el.className = 'text-brand-600 font-medium animate-pulse';
        foundCurrent = true;
      } else if (!foundCurrent) {
        el.removeAttribute('data-active');
        el.setAttribute('data-completed', 'true');
        el.className = 'text-status-completed-fg';
      } else {
        el.removeAttribute('data-active');
        el.removeAttribute('data-completed');
        el.className = 'text-neutral-400';
      }
    });
  }

  function appendLog(payload) {
    if (!liveLogList) return;
    const li = document.createElement('li');
    li.className = 'font-mono text-xs text-neutral-700 py-0.5 border-b border-neutral-800 last:border-0';

    let text = '';
    if (typeof payload === 'string') {
      text = payload;
    } else {
      try {
        text = JSON.stringify(payload);
      } catch (e) {
        text = String(payload);
      }
    }

    li.textContent = text;
    liveLogList.appendChild(li);

    // Auto-scroll
    const details = liveLogList.closest('details');
    if (details && details.open) {
      const container = liveLogList.parentElement;
      container.scrollTop = container.scrollHeight;
    }
  }

  function updateSubIssue(payload) {
    if (!subIssuesList || !subIssueTemplate) return;

    // Check if it already exists
    let existing = document.getElementById('sub-issue-' + payload.taskId);
    if (existing) {
      const statusEl = existing.querySelector('[data-sub-issue-status]');
      if (statusEl) {
        statusEl.textContent = payload.status || 'unknown';
        // Update classes based on status
        statusEl.className = 'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ' +
          (payload.status === 'success' ? 'bg-status-completed-bg text-status-completed-fg border-status-completed-border' :
           payload.status === 'failure' ? 'bg-status-failed-bg text-status-failed-fg border-status-failed-border' :
           'bg-status-running-bg text-status-running-fg border-status-running-border animate-pulse');
      }
      return;
    }

    // Create new
    const clone = subIssueTemplate.content.cloneNode(true);
    const li = clone.querySelector('li');
    li.id = 'sub-issue-' + payload.taskId;

    const titleEl = clone.querySelector('[data-sub-issue-title]');
    if (titleEl) titleEl.textContent = payload.title || payload.taskId;

    const linkEl = clone.querySelector('[data-sub-issue-link]');
    if (linkEl && payload.issueNumber) {
      linkEl.textContent = '#' + payload.issueNumber;
      linkEl.href = 'https://github.com/' + payload.repo + '/issues/' + payload.issueNumber;
    } else if (linkEl) {
      linkEl.style.display = 'none';
    }

    const statusEl = clone.querySelector('[data-sub-issue-status]');
    if (statusEl) {
      statusEl.textContent = payload.status || 'pending';
      statusEl.className = 'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border bg-status-queued-bg text-status-queued-fg border-status-queued-border';
    }

    subIssuesList.appendChild(clone);
  }

  function showError(payload) {
    if (!errorBanner || !errorBannerMessage) return;
    errorBanner.style.display = 'block';
    if (typeof payload === 'string') {
      errorBannerMessage.textContent = payload;
    } else if (payload && typeof payload.message === 'string') {
      errorBannerMessage.textContent = payload.message;
    } else {
      errorBannerMessage.textContent = JSON.stringify(payload);
    }
  }

  function parsePayload(event) {
    try {
      return JSON.parse(event.data);
    } catch (e) {
      showError(${JSON.stringify(failedParseMessage)});
      return undefined;
    }
  }

  function handleNamedEvent(event, handler) {
    if (typeof event.data !== 'string') return;
    const payload = parsePayload(event);
    if (payload === undefined) return;
    handler(payload);
  }

  es.addEventListener('phase', (event) => handleNamedEvent(event, (payload) => {
    const phase = payload && typeof payload.phase === 'string' ? payload.phase : payload;
    if (typeof phase === 'string') updatePhases(phase);
  }));

  es.addEventListener('subIssue', (event) => handleNamedEvent(event, updateSubIssue));
  es.addEventListener('log', (event) => handleNamedEvent(event, appendLog));
  es.addEventListener('session', (event) => handleNamedEvent(event, appendLog));

  es.addEventListener('complete', (event) => handleNamedEvent(event, (payload) => {
    if (stopButtonForm) stopButtonForm.style.display = 'none';
    if (statusBadge) {
      const terminalStatus = typeof payload.status === 'string' ? payload.status : 'completed';
      const isFailure = terminalStatus === 'failed' || terminalStatus === 'aborted';
      statusBadge.textContent = terminalStatus;
      statusBadge.className = 'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ' +
        (isFailure ? 'bg-status-failed-bg text-status-failed-fg border-status-failed-border' :
         'bg-status-completed-bg text-status-completed-fg border-status-completed-border');
    }
    if (payload.prUrl && prUrlContainer && prUrlLink) {
      prUrlContainer.style.display = 'flex';
      prUrlLink.href = payload.prUrl;
      prUrlLink.textContent = payload.prUrl.replace('https://github.com/', '');
    }
    es.close();
  }));

  es.addEventListener('error', (event) => {
    handleNamedEvent(event, showError);
  });
})();
`;
}

export const RunLiveScript: FC<RunLiveScriptProps> = ({ runId }) => {
  return <script type="module" dangerouslySetInnerHTML={{ __html: buildScriptContent(runId) }} />;
};
