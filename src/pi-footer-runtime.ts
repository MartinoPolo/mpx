import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { pathToFileURL } from 'node:url';
import { fallbackFooterRepository, footerCompactions, footerSessionCost, parseFooterQuota, repositoryFooterLocation, resolveFooterRepository, type FooterRepository } from './pi-footer-data.js';
import { renderPiFooter, type FooterAgent, type FooterCompaction, type FooterQuotaWindow, type FooterReview, type FooterView } from './pi-footer.js';
import { discoverFooterReview } from './footer-review.js';

import { readFooterCompactionSettings, type FooterCompactionSettings } from './pi-footer-settings.js';
import { requestFooterQuota } from './pi-footer-quota.js';

type FooterData = Parameters<NonNullable<Parameters<ExtensionContext['ui']['setFooter']>[0]>>[2];

export interface PiFooterComponent extends Component {
  update(context: ExtensionContext, history?: boolean): void;
  compacted(id: string, reason: string, context: ExtensionContext): void;
  response(headers: Record<string, string>, context: ExtensionContext): void;
  setView(view: FooterView): void;
  toggleView(): void;
  dispose(): void;
}

export function createPiFooterComponent(
  pi: ExtensionAPI,
  initialContext: ExtensionContext,
  tui: Pick<TUI, 'requestRender'>,
  theme: Pick<Theme, 'fg' | 'bold'>,
  footerData: FooterData,
  environment: Readonly<Record<string, string | undefined>>,
  agents: () => readonly FooterAgent[],
  loadRepository: (cwd: string) => Promise<FooterRepository> = resolveFooterRepository,
  loadCompactionSettings = readFooterCompactionSettings,
  loadQuota = requestFooterQuota,
  loadReview: (repository: FooterRepository, branch: string | null) => Promise<FooterReview | undefined> = discoverFooterReview,
): PiFooterComponent {
  let context = initialContext;
  let disposed = false;
  let view: FooterView = 'summary';
  let historyControlRow = -1;
  let repository = fallbackFooterRepository(context.cwd);
  let repositoryRefreshActive = false;
  let repositoryRefreshRequested = false;
  let review: FooterReview | undefined;
  let reviewRevision = 0;
  let reviewRefreshActive = false;
  let reviewRefreshRequested = false;
  let provider = context.model?.provider;
  let quota: FooterQuotaWindow[] | undefined;
  let quotaObservedAt: number | undefined;
  let cost: number | undefined;
  let compactions: FooterCompaction[] = [];
  let historyLeafId: string | null = null;
  const reasons = new Map<string, string>();
  const sessionFile = context.sessionManager.getSessionFile();
  const sessionUrl = sessionFile ? pathToFileURL(sessionFile).href : undefined;
  const sessionId = context.sessionManager.getSessionId();
  const render = () => { if (!disposed) tui.requestRender(); };
  let quotaRefreshController: AbortController | undefined;
  let quotaRefreshAttemptedAt = -Infinity;
  let quotaRevision = 0;
  const refreshQuota = () => {
    if (disposed || provider !== 'openai-codex' || quotaRefreshController || Date.now() - quotaRefreshAttemptedAt < 60_000) return;
    const controller = new AbortController();
    const revision = quotaRevision;
    quotaRefreshController = controller;
    quotaRefreshAttemptedAt = Date.now();
    void loadQuota(context, controller.signal).then(observed => {
      if (!disposed && !controller.signal.aborted && quotaRevision === revision && observed) {
        quota = observed.windows;
        quotaObservedAt = observed.observedAt;
        render();
      }
    }).catch(() => {
      // Keep the last observation through transient native-auth or quota-service failures.
    }).finally(() => {
      if (quotaRefreshController === controller) quotaRefreshController = undefined;
    });
  };
  let compactionSettings: FooterCompactionSettings | undefined;
  let settingsRefreshActive = false;
  let settingsRefreshedAt = -Infinity;
  const refreshSettings = () => {
    if (disposed || settingsRefreshActive || Date.now() - settingsRefreshedAt < 1000) return;
    settingsRefreshActive = true;
    settingsRefreshedAt = Date.now();
    void loadCompactionSettings(context.cwd).then(value => {
      if (!disposed && value !== undefined) { compactionSettings = value; render(); }
    }).catch(() => {
      // A transient settings-file replacement must not discard the last valid threshold.
    }).finally(() => { settingsRefreshActive = false; });
  };
  const refreshHistory = () => {
    historyLeafId = context.sessionManager.getLeafId();
    cost = footerSessionCost(context.sessionManager.getEntries());
    compactions = footerCompactions(context.sessionManager.getBranch(), reasons, sessionUrl);
  };
  const refreshReview = () => {
    if (disposed || !repository.reviewRepository) return;
    reviewRefreshRequested = true;
    if (reviewRefreshActive) return;
    reviewRefreshActive = true;
    void (async () => {
      try {
        while (!disposed && reviewRefreshRequested) {
          reviewRefreshRequested = false;
          const requestedRepository = repository;
          const requestedBranch = footerData.getGitBranch();
          const revision = reviewRevision;
          try {
            const value = await loadReview(requestedRepository, requestedBranch);
            if (!disposed && revision === reviewRevision && requestedRepository === repository
              && requestedBranch === footerData.getGitBranch() && !reviewRefreshRequested) {
              review = value;
              render();
            }
          } catch {
            // Review discovery is optional when the selected provider CLI or authentication is unavailable.
          }
        }
      } finally {
        reviewRefreshActive = false;
      }
    })();
  };
  const refreshRepository = () => {
    if (disposed) return;
    repositoryRefreshRequested = true;
    if (repositoryRefreshActive) return;
    repositoryRefreshActive = true;
    void (async () => {
      try {
        while (!disposed && repositoryRefreshRequested) {
          repositoryRefreshRequested = false;
          try {
            const value = await loadRepository(context.cwd);
            if (!disposed && !repositoryRefreshRequested) {
              repository = value;
              refreshReview();
              render();
            }
          } catch {
            // Keep the local fallback when Git metadata is unavailable.
          }
        }
      } finally {
        repositoryRefreshActive = false;
      }
    })();
  };
  refreshHistory();
  refreshRepository();
  refreshSettings();
  refreshQuota();
  const unsubscribeBranch = footerData.onBranchChange(() => {
    reviewRevision++;
    review = undefined;
    refreshRepository();
    render();
  });
  const clock = setInterval(() => { refreshSettings(); refreshQuota(); refreshReview(); render(); }, 60_000);
  clock.unref();

  const update = (next: ExtensionContext, history = false) => {
    if (disposed || next.sessionManager.getSessionId() !== sessionId) return;
    if (next.model?.provider !== provider) {
      quotaRefreshController?.abort();
      quotaRefreshController = undefined;
      quotaRefreshAttemptedAt = -Infinity;
      quotaRevision++;
      provider = next.model?.provider;
      quota = undefined;
      quotaObservedAt = undefined;
    }
    context = next;
    refreshSettings();
    refreshQuota();
    if (history) refreshHistory();
    render();
  };
  return {
    update,
    compacted(id, reason, next) {
      if (disposed || next.sessionManager.getSessionId() !== sessionId) return;
      reasons.set(id, reason);
      update(next, true);
    },
    response(headers, next) {
      update(next);
      if (disposed || next.sessionManager.getSessionId() !== sessionId || provider !== 'openai-codex') return;
      const now = Date.now();
      const observed = parseFooterQuota(headers, now);
      if (observed) { quotaRevision++; quota = observed; quotaObservedAt = now; render(); }
    },
    setView(nextView) {
      if (disposed || view === nextView) return;
      view = nextView;
      render();
    },
    toggleView() {
      if (disposed) return;
      view = view === 'compact' ? 'summary' : 'compact';
      render();
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (disposed || event.type !== 'click' || event.button !== 'left') return undefined;
      if (event.y === 0 && event.x === 0) {
        view = view === 'compact' ? 'summary' : 'compact';
        render();
        return { handled: true, render: true };
      }
      if (event.y === historyControlRow && event.x === 0 && view !== 'compact') {
        view = view === 'details' ? 'summary' : 'details';
        render();
        return { handled: true, render: true };
      }
      return undefined;
    },
    invalidate() {},
    render(width) {
      if (disposed) return [];
      // Native message_end handlers run before session persistence.
      if (context.sessionManager.getLeafId() !== historyLeafId) refreshHistory();
      const account = environment.MPX_ACCOUNT;
      const contextUsage = context.getContextUsage();
      const contextWindow = contextUsage?.contextWindow ?? context.model?.contextWindow;
      const compactionTrigger = compactionSettings && contextWindow !== undefined && Number.isFinite(contextWindow)
        ? compactionSettings.enabled ? Math.max(0, contextWindow - compactionSettings.reserveTokens) : 0
        : undefined;
      const lines = renderPiFooter({
        sessionName: pi.getSessionName(),
        sessionId,
        sessionUrl,
        account: account === 'personal' || account === 'work' ? account : undefined,
        model: context.model?.id,
        effort: context.thinkingLevel,
        location: repositoryFooterLocation(repository, footerData.getGitBranch()),
        review,
        contextPercent: contextUsage?.percent,
        contextTokens: contextUsage?.tokens,
        compactionTrigger,
        cost,
        compactions,
        quota,
        quotaObservedAt,
        agents: agents(),
      }, width, theme, view);
      historyControlRow = lines.findIndex(line => /^(?:▸|▾) History/.test(stripTerminalSequences(line)));
      return lines;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      quotaRefreshController?.abort();
      quotaRefreshController = undefined;
      repositoryRefreshRequested = false;
      reviewRefreshRequested = false;
      reviewRevision++;
      clearInterval(clock);
      unsubscribeBranch();
    },
  };
}
