import './index.css';

import { Component, StrictMode, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apiClient } from './lib/apiClient';
import type {
  AuditEntry,
  AuditResponse,
  DashboardResponse,
  ModerationRules,
  QueueItem,
  ReportedPostsResponse,
  ReportedPostRow,
  RulesResponse,
  SummaryStats,
} from '../shared/mod';

type TabName = 'queue' | 'reported' | 'processed' | 'audit' | 'rules';

type Toast = { id: number; message: string };

type LoadingMap = Record<string, boolean>;

class TabErrorBoundary extends Component<
  { children: ReactNode; label: string },
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm">Failed to load {this.props.label}.</div>;
    }
    return this.props.children;
  }
}

const Spinner = () => <span className="spinner" aria-label="Loading" />;

const SkeletonBar = ({ className = '' }: { className?: string }) => (
  <div className={`skeleton h-4 rounded ${className}`} />
);

const App = () => {
  const PAGE_SIZE = 20;
  const [activeTab, setActiveTab] = useState<TabName>('queue');
  const [isLoading, setIsLoading] = useState(true);
  const [summary, setSummary] = useState<SummaryStats | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [reportedPosts, setReportedPosts] = useState<ReportedPostRow[]>([]);
  const [processedPosts, setProcessedPosts] = useState<ReportedPostRow[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [rules, setRules] = useState<ModerationRules | null>(null);
  const [approveInput, setApproveInput] = useState('0.15');
  const [removeInput, setRemoveInput] = useState('0.85');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [loadingMap, setLoadingMap] = useState<LoadingMap>({});
  const [auditFilter, setAuditFilter] = useState('');
  const [reportSort, setReportSort] = useState<'count' | 'recent'>('count');
  const [queuePage, setQueuePage] = useState(1);
  const [reportedPage, setReportedPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [processedPage, setProcessedPage] = useState(1);
  const [queueHasMore, setQueueHasMore] = useState(false);
  const [reportedHasMore, setReportedHasMore] = useState(false);
  const [processedHasMore, setProcessedHasMore] = useState(false);
  const [auditHasMore, setAuditHasMore] = useState(false);

  const toastSeq = useRef(0);

  const addToast = (message: string) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 3000);
  };

  const runWithLoading = async (key: string, task: () => Promise<void>) => {
    setLoadingMap((prev) => ({ ...prev, [key]: true }));
    try {
      await task();
    } finally {
      setLoadingMap((prev) => ({ ...prev, [key]: false }));
    }
  };

  const refreshQueueSummary = async () => {
    setIsLoading(true);
    try {
      const dashboard = await apiClient.request<DashboardResponse>(
        `/api/dashboard?page=${queuePage}&pageSize=${PAGE_SIZE}`,
        {},
        addToast
      );

      setSummary(dashboard.summary);
      setQueue(dashboard.queue);
      setQueueHasMore(dashboard.queue.length === PAGE_SIZE);
    } finally {
      setIsLoading(false);
    }
  };

  const refreshReported = async () => {
    const reports = await apiClient.request<ReportedPostsResponse>(
      `/api/reported-posts?page=${reportedPage}&pageSize=${PAGE_SIZE}&sort=${reportSort}&status=active`,
      {},
      addToast
    );
    setReportedPosts(reports.posts);
    setReportedHasMore(reports.posts.length === PAGE_SIZE);
  };

  const refreshProcessed = async () => {
    const reports = await apiClient.request<ReportedPostsResponse>(
      `/api/reported-posts?page=${processedPage}&pageSize=${PAGE_SIZE}&sort=recent&status=processed`,
      {},
      addToast
    );
    setProcessedPosts(reports.posts);
    setProcessedHasMore(reports.posts.length === PAGE_SIZE);
  };

  const refreshAudit = async () => {
    const auditRes = await apiClient.request<AuditResponse>(
      `/api/audit?page=${auditPage}&pageSize=${PAGE_SIZE}`,
      {},
      addToast
    );
    setAudit(auditRes.entries);
    setAuditHasMore(auditRes.entries.length === PAGE_SIZE);
  };

  const refreshRules = async () => {
    const res = await apiClient.request<RulesResponse>('/api/rules', {}, addToast);
    setRules(res.rules);
    setApproveInput(String(res.rules.autoApproveThreshold));
    setRemoveInput(String(res.rules.autoRemoveThreshold));
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshQueueSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuePage]);

  useEffect(() => {
    if (activeTab === 'reported') {
      void refreshReported();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, reportedPage, reportSort]);

  useEffect(() => {
    if (activeTab === 'processed') {
      void refreshProcessed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, processedPage]);

  useEffect(() => {
    if (activeTab === 'audit') {
      void refreshAudit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, auditPage]);

  useEffect(() => {
    if (activeTab === 'rules') {
      void refreshRules();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const makeAction = async (postId: string, action: 'approve' | 'remove') => {
    const optimisticQueue = queue.filter((item) => item.postId !== postId);
    const prevQueue = queue;
    setQueue(optimisticQueue);

    try {
      await apiClient.request('/api/action/' + action, {
        method: 'POST',
        body: JSON.stringify({ postId, subredditId: '', modId: '', reason: 'manual_action' }),
      }, addToast);
      addToast(`${action} completed for ${postId}`);
      await refreshQueueSummary();
      if (activeTab === 'reported') {
        await refreshReported();
        await refreshProcessed();
      }
    } catch {
      setQueue(prevQueue);
      addToast(`${action} failed, rolled back`);
    }
  };

  const claim = async (postId: string) => {
    await apiClient.request('/api/action/claim', {
      method: 'POST',
      body: JSON.stringify({ postId }),
    }, addToast);
    addToast(`Claimed ${postId}`);
    await refreshQueueSummary();
  };

  const escalate = async (postId: string) => {
    await apiClient.request('/api/action/escalate', {
      method: 'POST',
      body: JSON.stringify({ postId, reason: 'needs_human_escalation' }),
    }, addToast);
    addToast(`Escalated ${postId}`);
    await refreshQueueSummary();
  };

  const scoreNow = async (row: ReportedPostRow) => {
    const prev = [...reportedPosts];
    setReportedPosts((items) =>
      items.map((item) =>
        item.meta.postId === row.meta.postId
          ? {
              ...item,
              score: {
                ...(item.score ?? {
                  postId: row.meta.postId,
                  subredditId: row.meta.subredditId,
                  title: row.meta.title,
                  body: '',
                  authorName: row.meta.authorName,
                  accountAgeDays: 0,
                  karma: 0,
                  reportCount: row.meta.reportCount,
                  priorFlagsInSub: 0,
                  createdAt: Date.now(),
                }),
                score: 0.5,
                label: 'borderline',
                reasons: ['scoring_in_progress'],
                suggested_action: 'review',
              },
            }
          : item
      )
    );

    try {
      await apiClient.request('/api/score-content', {
        method: 'POST',
        body: JSON.stringify({
          postId: row.meta.postId,
          title: row.meta.title,
          body: '',
          authorName: row.meta.authorName,
          accountAgeDays: 365,
          karma: 0,
          reportCount: row.meta.reportCount,
          priorFlagsInSub: 0,
        }),
      }, addToast);

      addToast(`Scored ${row.meta.postId}`);
      await refreshReported();
    } catch {
      setReportedPosts(prev);
      addToast('Score failed, rolled back');
    }
  };

  const bulkSmartAction = async () => {
    const preview = await apiClient.request<{ success: boolean; candidates: QueueItem[] }>(
      '/api/bulk/preview',
      {},
      addToast
    );

    if (preview.candidates.length === 0) {
      addToast('No candidates for bulk smart action');
      return;
    }

    const ok = confirm(`Apply suggested action to ${preview.candidates.length} posts?`);
    if (!ok) {
      return;
    }

    await apiClient.request('/api/bulk/apply', {
      method: 'POST',
      body: JSON.stringify({ modId: 'bulk_mod' }),
    }, addToast);

    addToast('Bulk smart action completed');
    await refreshQueueSummary();
  };

  const filteredAudit = useMemo(() => {
    const needle = auditFilter.trim().toLowerCase();
    if (!needle) {
      return audit;
    }
    return audit.filter((entry) => {
      return (
        (entry.modId ?? '').toLowerCase().includes(needle) ||
        (entry.postTitle ?? '').toLowerCase().includes(needle)
      );
    });
  }, [audit, auditFilter]);

  const sortedReported = useMemo(() => {
    const copy = [...reportedPosts];
    if (reportSort === 'count') {
      copy.sort((a, b) => b.meta.reportCount - a.meta.reportCount);
    } else {
      copy.sort((a, b) => b.meta.lastReportedAt - a.meta.lastReportedAt);
    }
    return copy;
  }, [reportedPosts, reportSort]);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 p-4 md:p-6">
      <div className="max-w-6xl mx-auto space-y-4">
        <header className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h1 className="text-2xl font-semibold">Smart Intelligent Queue</h1>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2">
            {isLoading || !summary ? (
              Array.from({ length: 5 }).map((_, idx) => (
                <div key={idx} className="rounded-lg border border-slate-200 p-3">
                  <SkeletonBar className="w-12 mb-2" />
                  <SkeletonBar className="w-20" />
                </div>
              ))
            ) : (
              <>
                <StatCard label="Processed" value={summary.totalProcessed} />
                <StatCard label="Removed Today" value={summary.removedToday} />
                <StatCard label="Approved Today" value={summary.approvedToday} />
                <StatCard label="In Queue" value={summary.queueCount} />
                <StatCard label="Reported" value={summary.reportedCount} />
              </>
            )}
          </div>
        </header>

        <nav className="flex gap-2">
          <TabButton active={activeTab === 'queue'} onClick={() => setActiveTab('queue')}>
            Priority Queue
          </TabButton>
          <TabButton active={activeTab === 'reported'} onClick={() => setActiveTab('reported')}>
            Reported Posts
          </TabButton>
          <TabButton active={activeTab === 'processed'} onClick={() => setActiveTab('processed')}>
            Processed Reports
          </TabButton>
          <TabButton active={activeTab === 'audit'} onClick={() => setActiveTab('audit')}>
            Audit Log
          </TabButton>
          <TabButton active={activeTab === 'rules'} onClick={() => setActiveTab('rules')}>
            Rules
          </TabButton>
        </nav>

        {activeTab === 'queue' && (
          <TabErrorBoundary label="Priority Queue">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <button
              className="action-btn bg-indigo-600 text-white"
              disabled={Boolean(loadingMap.bulk)}
              onClick={() => runWithLoading('bulk', bulkSmartAction)}
            >
              {loadingMap.bulk ? <Spinner /> : 'Bulk Smart Approve/Remove'}
            </button>
            <div className="mt-3 space-y-2">
              {isLoading
                ? Array.from({ length: 5 }).map((_, idx) => (
                    <div key={idx} className="rounded-lg border border-slate-200 p-3">
                      <SkeletonBar className="w-1/2 mb-2" />
                      <SkeletonBar className="w-2/3" />
                    </div>
                  ))
                : queue.map((item) => (
                    <article key={item.postId} className="clickable-card rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-medium">{item.title.slice(0, 60)}</p>
                          <p className="text-sm text-slate-500">u/{item.authorName}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <ScoreBadge score={item.score} />
                            {item.reportCount > 0 && <Tag label={`reports: ${item.reportCount}`} />}
                            {item.reasons.map((reason) => (
                              <Tag key={reason} label={reason} />
                            ))}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <ActionButton
                            loading={Boolean(loadingMap[`claim-${item.postId}`])}
                            onClick={() => runWithLoading(`claim-${item.postId}`, () => claim(item.postId))}
                            tone="slate"
                            label="Claim"
                          />
                          <ActionButton
                            loading={Boolean(loadingMap[`approve-${item.postId}`])}
                            onClick={() => runWithLoading(`approve-${item.postId}`, () => makeAction(item.postId, 'approve'))}
                            tone="green"
                            label="Approve"
                          />
                          <ActionButton
                            loading={Boolean(loadingMap[`remove-${item.postId}`])}
                            onClick={() => runWithLoading(`remove-${item.postId}`, () => makeAction(item.postId, 'remove'))}
                            tone="red"
                            label="Remove"
                          />
                          <ActionButton
                            loading={Boolean(loadingMap[`escalate-${item.postId}`])}
                            onClick={() => runWithLoading(`escalate-${item.postId}`, () => escalate(item.postId))}
                            tone="amber"
                            label="Escalate"
                          />
                        </div>
                      </div>
                    </article>
                  ))}
            </div>
            {(queuePage > 1 || queueHasMore) && (
              <div className="mt-3 flex gap-2">
                {queuePage > 1 && <button className="action-btn bg-slate-200" onClick={() => setQueuePage((p) => Math.max(1, p - 1))}>Prev</button>}
                {queueHasMore && <button className="action-btn bg-slate-200" onClick={() => setQueuePage((p) => p + 1)}>Next</button>}
              </div>
            )}
          </section>
          </TabErrorBoundary>
        )}

        {activeTab === 'reported' && (
          <TabErrorBoundary label="Reported Posts">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3">
              <button className="action-btn bg-slate-700 text-white" onClick={() => setReportSort(reportSort === 'count' ? 'recent' : 'count')}>
                Sort: {reportSort === 'count' ? 'Report Count' : 'Most Recent'}
              </button>
            </div>
            <div className="space-y-2">
              {sortedReported.map((row) => (
                <article key={row.meta.postId} className="clickable-card rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{row.meta.title}</p>
                      <p className="text-sm text-slate-500">u/{row.meta.authorName}</p>
                      <div className="mt-1 flex gap-2 text-xs">
                        <Tag label={`reports ${row.meta.reportCount}`} />
                        <Tag label={`first ${new Date(row.meta.firstReportedAt).toLocaleString()}`} />
                        <Tag label={`last ${new Date(row.meta.lastReportedAt).toLocaleString()}`} />
                        {row.score ? <ScoreBadge score={row.score.score} /> : <Tag label="not yet scored" />}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <ActionButton
                        loading={Boolean(loadingMap[`score-${row.meta.postId}`])}
                        onClick={() => runWithLoading(`score-${row.meta.postId}`, () => scoreNow(row))}
                        tone="indigo"
                        label="Score now"
                      />
                      <ActionButton
                        loading={Boolean(loadingMap[`rapprove-${row.meta.postId}`])}
                        onClick={() => runWithLoading(`rapprove-${row.meta.postId}`, () => makeAction(row.meta.postId, 'approve'))}
                        tone="green"
                        label="Approve"
                      />
                      <ActionButton
                        loading={Boolean(loadingMap[`rremove-${row.meta.postId}`])}
                        onClick={() => runWithLoading(`rremove-${row.meta.postId}`, () => makeAction(row.meta.postId, 'remove'))}
                        tone="red"
                        label="Remove"
                      />
                    </div>
                  </div>
                </article>
              ))}
            </div>
            {(reportedPage > 1 || reportedHasMore) && (
              <div className="mt-3 flex gap-2">
                {reportedPage > 1 && <button className="action-btn bg-slate-200" onClick={() => setReportedPage((p) => Math.max(1, p - 1))}>Prev</button>}
                {reportedHasMore && <button className="action-btn bg-slate-200" onClick={() => setReportedPage((p) => p + 1)}>Next</button>}
              </div>
            )}
          </section>
          </TabErrorBoundary>
        )}

        {activeTab === 'processed' && (
          <TabErrorBoundary label="Processed Reports">
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="space-y-2">
                {processedPosts.map((row) => (
                  <article key={row.meta.postId} className="clickable-card rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{row.meta.title}</p>
                        <p className="text-sm text-slate-500">u/{row.meta.authorName}</p>
                        <div className="mt-1 flex gap-2 text-xs">
                          <Tag label={`reports ${row.meta.reportCount}`} />
                          <Tag label={`last ${new Date(row.meta.lastReportedAt).toLocaleString()}`} />
                          {row.meta.processedAction && <Tag label={`processed: ${row.meta.processedAction}`} />}
                          {row.score ? <ScoreBadge score={row.score.score} /> : <Tag label="no score" />}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
              {(processedPage > 1 || processedHasMore) && (
                <div className="mt-3 flex gap-2">
                  {processedPage > 1 && <button className="action-btn bg-slate-200" onClick={() => setProcessedPage((p) => Math.max(1, p - 1))}>Prev</button>}
                  {processedHasMore && <button className="action-btn bg-slate-200" onClick={() => setProcessedPage((p) => p + 1)}>Next</button>}
                </div>
              )}
            </section>
          </TabErrorBoundary>
        )}

        {activeTab === 'audit' && (
          <TabErrorBoundary label="Audit Log">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <input
              className="w-full rounded-md border border-slate-300 px-3 py-2"
              placeholder="Filter by mod username or post title"
              value={auditFilter}
              onChange={(event) => setAuditFilter(event.target.value)}
            />
            <div className="mt-3 space-y-2">
              {filteredAudit.map((entry) => (
                <article key={`${entry.postId}-${entry.timestamp}-${entry.action}`} className="clickable-card rounded-lg border border-slate-200 p-3">
                  <p className="text-sm text-slate-500">{new Date(entry.timestamp).toLocaleString()} - {entry.modId}</p>
                  <p className="font-medium">{entry.postTitle}</p>
                  <div className="mt-1 flex gap-2 text-xs">
                    <Tag label={entry.action} />
                    <Tag label={`score ${entry.score.toFixed(2)}`} />
                    {(entry.reasons ?? []).map((reason) => (
                      <Tag key={reason} label={reason} />
                    ))}
                  </div>
                </article>
              ))}
            </div>
            {(auditPage > 1 || auditHasMore) && (
              <div className="mt-3 flex gap-2">
                {auditPage > 1 && <button className="action-btn bg-slate-200" onClick={() => setAuditPage((p) => Math.max(1, p - 1))}>Prev</button>}
                {auditHasMore && <button className="action-btn bg-slate-200" onClick={() => setAuditPage((p) => p + 1)}>Next</button>}
              </div>
            )}
          </section>
          </TabErrorBoundary>
        )}

        {activeTab === 'rules' && (
          <TabErrorBoundary label="Rules">
            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
              {!rules ? (
                <div className="space-y-2">
                  <SkeletonBar className="w-1/3" />
                  <SkeletonBar className="w-full" />
                </div>
              ) : (
                <>
                  <label className="text-sm block">
                    Auto Approve Threshold
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      className="w-full mt-2"
                      value={rules.autoApproveThreshold}
                      onChange={(e) => {
                        const value = Number.parseFloat(e.target.value);
                        setRules({ ...rules, autoApproveThreshold: value });
                        setApproveInput(e.target.value);
                      }}
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      className="w-full rounded-md border border-slate-300 px-3 py-2 mt-1"
                      value={approveInput}
                      onChange={(e) => {
                        const value = e.target.value;
                        setApproveInput(value);
                        if (/^(0(\.\d{0,2})?|1(\.0{0,2})?)$/.test(value)) {
                          setRules({ ...rules, autoApproveThreshold: Number.parseFloat(value) });
                        }
                      }}
                    />
                  </label>
                  <label className="text-sm block">
                    Auto Remove Threshold
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      className="w-full mt-2"
                      value={rules.autoRemoveThreshold}
                      onChange={(e) => {
                        const value = Number.parseFloat(e.target.value);
                        setRules({ ...rules, autoRemoveThreshold: value });
                        setRemoveInput(e.target.value);
                      }}
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      className="w-full rounded-md border border-slate-300 px-3 py-2 mt-1"
                      value={removeInput}
                      onChange={(e) => {
                        const value = e.target.value;
                        setRemoveInput(value);
                        if (/^(0(\.\d{0,2})?|1(\.0{0,2})?)$/.test(value)) {
                          setRules({ ...rules, autoRemoveThreshold: Number.parseFloat(value) });
                        }
                      }}
                    />
                  </label>
                  <label className="text-sm block">
                    Community Rules (one per line)
                    <textarea
                      className="w-full rounded-md border border-slate-300 px-3 py-2 mt-1 min-h-[140px]"
                      value={rules.communityRules.join('\n')}
                      onChange={(e) =>
                        setRules({
                          ...rules,
                          communityRules: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean),
                        })
                      }
                    />
                  </label>
                  <button
                    className="action-btn bg-indigo-600 text-white"
                    onClick={() =>
                      runWithLoading('save-rules', async () => {
                        const approve = Number.parseFloat(approveInput);
                        const remove = Number.parseFloat(removeInput);
                        if (!Number.isFinite(approve) || !Number.isFinite(remove) || approve < 0 || approve > 1 || remove < 0 || remove > 1) {
                          addToast('Thresholds must be numbers between 0 and 1');
                          return;
                        }
                        await apiClient.request<RulesResponse>(
                          '/api/rules',
                          {
                            method: 'POST',
                            body: JSON.stringify({
                              ...rules,
                              autoApproveThreshold: approve,
                              autoRemoveThreshold: remove,
                            }),
                          },
                          addToast
                        );
                        addToast('Rules updated');
                        await refreshRules();
                      })
                    }
                  >
                    {loadingMap['save-rules'] ? <Spinner /> : 'Save Rules'}
                  </button>
                </>
              )}
            </section>
          </TabErrorBoundary>
        )}
      </div>

      <div className="fixed bottom-4 right-4 z-50 space-y-2">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast rounded-md bg-slate-900 px-3 py-2 text-sm text-white shadow-lg">
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
};

const StatCard = ({ label, value }: { label: string; value: number }) => (
  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
    <p className="text-xl font-semibold">{value}</p>
    <p className="text-xs text-slate-600">{label}</p>
  </div>
);

const Tag = ({ label }: { label: string }) => (
  <span className="rounded-full bg-slate-200 px-2 py-1 text-[11px]">{label}</span>
);

const ScoreBadge = ({ score }: { score: number }) => {
  const cls = score >= 0.7 ? 'bg-red-100 text-red-700' : score >= 0.4 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700';
  return <span className={`rounded-full px-2 py-1 text-[11px] ${cls}`}>score {score.toFixed(2)}</span>;
};

const TabButton = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) => (
  <button className={`action-btn ${active ? 'bg-slate-800 text-white' : 'bg-white text-slate-700'}`} onClick={onClick}>
    {children}
  </button>
);

const ActionButton = ({
  loading,
  onClick,
  tone,
  label,
}: {
  loading: boolean;
  onClick: () => void;
  tone: 'green' | 'red' | 'slate' | 'amber' | 'indigo';
  label: string;
}) => {
  const tones: Record<string, string> = {
    green: 'bg-emerald-600 text-white',
    red: 'bg-rose-600 text-white',
    slate: 'bg-slate-200 text-slate-800',
    amber: 'bg-amber-500 text-white',
    indigo: 'bg-indigo-600 text-white',
  };

  return (
    <button className={`action-btn ${tones[tone]}`} onClick={onClick} disabled={loading}>
      {loading ? <Spinner /> : label}
    </button>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
