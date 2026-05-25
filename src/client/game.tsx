import './index.css';

import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apiClient } from './lib/apiClient';

type TabKey = 'priority' | 'escalated' | 'reported' | 'audit' | 'rules';
type FeedSort = 'risk_desc' | 'risk_asc' | 'newest';
type ModAction = 'approve' | 'remove' | 'escalate';
type Difficulty = 'easy' | 'medium' | 'hard' | 'legendary';

type QueuePost = {
  id: string;
  title: string;
  author: string;
  score: number;
  difficulty: Difficulty;
  reasons: string[];
  reportCount: number;
  createdAt: string;
  type: 'post' | 'comment';
};

type QueueResponse = { type: 'QUEUE_POSTS_RESPONSE'; posts: QueuePost[] };
type StatsResponse = {
  type: 'STATS_RESPONSE';
  processed: number;
  removed: number;
  approved: number;
  inQueue: number;
  reported: number;
};

type AuditItem = {
  ts: string;
  mod: string;
  title: string;
  action: 'approved' | 'removed' | 'escalated';
  score: string;
  reasons: string[];
};

type ToastTone = 'success' | 'error' | 'info';
type Toast = { id: number; text: string; tone: ToastTone };
type AccessResponse = { success: boolean; isModerator: boolean };

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'priority', label: 'Priority Queue' },
  { key: 'escalated', label: 'Escalated Queue' },
  { key: 'reported', label: 'Reported Posts' },
  { key: 'audit', label: 'Audit Log' },
  { key: 'rules', label: 'Rules' },
];

const sortOptions: Array<{ value: FeedSort; label: string }> = [
  { value: 'risk_desc', label: 'Sort by: Risk score' },
  { value: 'risk_asc', label: 'Sort by: Lowest risk' },
  { value: 'newest', label: 'Sort by: Newest' },
];

const actionLabels: Record<ModAction, string> = {
  approve: 'Approve',
  remove: 'Remove',
  escalate: 'Escalate',
};

const difficultyClass: Record<Difficulty, string> = {
  easy: 'bg-[#22C55E]/20 text-[#86EFAC] border border-[#22C55E]/30',
  medium: 'bg-[#F59E0B]/20 text-[#FCD34D] border border-[#F59E0B]/30',
  hard: 'bg-[#EF4444]/20 text-[#FCA5A5] border border-[#EF4444]/30',
  legendary: 'legend-pill bg-[#7C5CFC]/20 text-[#C4B5FD] border border-[#7C5CFC]/35',
};

const difficultyText: Record<Difficulty, string> = {
  easy: 'EASY',
  medium: 'MEDIUM',
  hard: 'HARD',
  legendary: 'LEGENDARY',
};

const App = () => {
  const [activeTab, setActiveTab] = useState<TabKey>('priority');
  const [queuePosts, setQueuePosts] = useState<QueuePost[]>([]);
  const [reportedPosts, setReportedPosts] = useState<QueuePost[]>([]);
  const [escalatedPosts, setEscalatedPosts] = useState<QueuePost[]>([]);
  const [loadingEscalated, setLoadingEscalated] = useState(true);
  const [auditLog, setAuditLog] = useState<AuditItem[]>([]);
  const [stats, setStats] = useState({ processed: 0, removed: 0, approved: 0, inQueue: 0, reported: 0 });
  const [feedSort, setFeedSort] = useState<FeedSort>('risk_desc');
  const [auditFilter, setAuditFilter] = useState('');
  const [approveThreshold, setApproveThreshold] = useState(0.15);
  const [removeThreshold, setRemoveThreshold] = useState(0.85);
  const [rulesText, setRulesText] = useState('Be civil\nNo direct threats\nNo promotional spam\nRespect reporting process');
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [loadingReported, setLoadingReported] = useState(true);
  const [processingIds, setProcessingIds] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState<ModAction | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [accessState, setAccessState] = useState<'checking' | 'allowed' | 'denied'>('checking');

  const addToast = (text: string, tone: ToastTone): void => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 3000);
  };

  const sendQueueMessage = async (): Promise<QueueResponse> => {
    return apiClient.request<QueueResponse>('/api/queue');
  };

  const sendStatsMessage = async (): Promise<StatsResponse> => {
    return apiClient.request<StatsResponse>('/api/stats');
  };

  const checkAccess = async (): Promise<boolean> => {
    try {
      const response = await apiClient.request<AccessResponse>('/api/access');
      if (!response.isModerator) {
        setAccessState('denied');
        return false;
      }
      setAccessState('allowed');
      return true;
    } catch {
      setAccessState('denied');
      return false;
    }
  };

  const refreshQueue = async (): Promise<void> => {
    setLoadingQueue(true);
    try {
      const response = await sendQueueMessage();
      setQueuePosts(response.posts);
      setSelectedIds(new Set());
    } catch {
      setQueuePosts([]);
      addToast('Queue fetch failed', 'error');
    } finally {
      setLoadingQueue(false);
    }
  };

  const refreshReported = async (): Promise<void> => {
    setLoadingReported(true);
    try {
      const res = await apiClient.request<{ success: boolean; posts: Array<{ meta: { postId: string; title: string; authorName: string; reportCount: number; lastReportedAt: number }; score?: { score: number; reasons: string[] } }> }>('/api/reported-posts?page=1&pageSize=50&sort=recent&status=active');
      const mapped = res.posts.map((row) => {
        const score = row.score?.score ?? 0.5;
        return {
          id: row.meta.postId,
          title: row.meta.title,
          author: row.meta.authorName,
          score,
          difficulty: scoreToDifficulty(score),
          reasons: row.score?.reasons ?? ['Recent report'],
          reportCount: row.meta.reportCount,
          createdAt: new Date(row.meta.lastReportedAt).toISOString(),
          type: 'post' as const,
        };
      });
      setReportedPosts(mapped);
    } catch {
      setReportedPosts([]);
    } finally {
      setLoadingReported(false);
    }
  };

  const refreshEscalated = async (): Promise<void> => {
    setLoadingEscalated(true);
    try {
      const res = await apiClient.request<{ type: string; posts: QueuePost[] }>('/api/escalated');
      setEscalatedPosts(res.posts);
    } catch {
      setEscalatedPosts([]);
    } finally {
      setLoadingEscalated(false);
    }
  };

  const refreshStats = async (): Promise<void> => {
    try {
      const response = await sendStatsMessage();
      setStats({
        processed: response.processed,
        removed: response.removed,
        approved: response.approved,
        inQueue: response.inQueue,
        reported: response.reported,
      });
    } catch {
      return;
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        const allowed = await checkAccess();
        if (!allowed) {
          return;
        }
        void refreshQueue();
        void refreshReported();
        void refreshEscalated();
        void refreshStats();
      })();
    }, 0);
    const interval = setInterval(() => {
      if (accessState === 'allowed') {
        void refreshStats();
      }
    }, 30000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sortedQueuePosts = useMemo(() => {
    const copy = [...queuePosts];
    if (feedSort === 'risk_desc') {
      copy.sort((a, b) => b.score - a.score);
      return copy;
    }
    if (feedSort === 'risk_asc') {
      copy.sort((a, b) => a.score - b.score);
      return copy;
    }
    copy.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return copy;
  }, [feedSort, queuePosts]);

  const filteredAudit = useMemo(() => {
    const needle = auditFilter.trim().toLowerCase();
    if (!needle) {
      return auditLog;
    }
    return auditLog.filter((entry) => entry.mod.toLowerCase().includes(needle) || entry.title.toLowerCase().includes(needle));
  }, [auditFilter, auditLog]);

  const visibleIds = sortedQueuePosts.map((post) => post.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  const toggleSelect = (postId: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) {
        next.delete(postId);
      } else {
        next.add(postId);
      }
      return next;
    });
  };

  const selectAllVisible = (): void => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      }
      const next = new Set(prev);
      visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const clearSelection = (): void => setSelectedIds(new Set());

  const removePostsFromQueue = (ids: string[]): void => {
    const idSet = new Set(ids);
    setQueuePosts((prev) => prev.filter((post) => !idSet.has(post.id)));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  };

  const appendAudit = (post: QueuePost, action: ModAction): void => {
    const mappedAction = action === 'approve' ? 'approved' : action === 'remove' ? 'removed' : 'escalated';
    setAuditLog((prev) => [
      {
        ts: formatNow(),
        mod: 'u/rusil4421',
        title: post.title,
        action: mappedAction,
        score: post.score.toFixed(2),
        reasons: post.reasons,
      },
      ...prev,
    ]);
  };

  const runSingleAction = async (post: QueuePost, action: ModAction): Promise<void> => {
    setProcessingIds((prev) => ({ ...prev, [post.id]: true }));
    try {
      await apiClient.request<{ success: boolean }>('/api/mod-action', {
        method: 'POST',
        body: JSON.stringify({ type: 'MOD_ACTION', action, postId: post.id }),
      });
      appendAudit(post, action);
      removePostsFromQueue([post.id]);
      addToast(`${actionLabels[action]}d 1 post`, 'success');
      void refreshStats();
      if (action === 'escalate') void refreshEscalated();
    } catch {
      addToast('Action failed — try again', 'error');
    } finally {
      setProcessingIds((prev) => ({ ...prev, [post.id]: false }));
    }
  };

  const runEscalatedAction = async (post: QueuePost, action: 'approve' | 'remove'): Promise<void> => {
    setProcessingIds((prev) => ({ ...prev, [post.id]: true }));
    try {
      await apiClient.request<{ success: boolean }>('/api/escalated-action', {
        method: 'POST',
        body: JSON.stringify({ action, postId: post.id }),
      });
      setEscalatedPosts((prev) => prev.filter((p) => p.id !== post.id));
      addToast(`${actionLabels[action]}d 1 escalated post`, 'success');
      void refreshStats();
    } catch {
      addToast('Action failed — try again', 'error');
    } finally {
      setProcessingIds((prev) => ({ ...prev, [post.id]: false }));
    }
  };

  const runBulkAction = async (action: ModAction): Promise<void> => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      return;
    }
    setBulkLoading(action);
    try {
      const res = await apiClient.request<{ success: boolean; updated: number }>('/api/bulk-action', {
        method: 'POST',
        body: JSON.stringify({ type: 'BULK_ACTION', action, postIds: ids }),
      });
      const actioned = queuePosts.filter((post) => selectedIds.has(post.id));
      actioned.forEach((post) => appendAudit(post, action));
      removePostsFromQueue(ids);
      addToast(`${res.updated} posts ${action === 'approve' ? 'approved' : action === 'remove' ? 'removed' : 'escalated'}`, 'success');
      void refreshStats();
      if (action === 'escalate') void refreshEscalated();
    } catch {
      addToast('Action failed — try again', 'error');
    } finally {
      setBulkLoading(null);
    }
  };

  const runAutoThresholdAction = async (action: 'approve' | 'remove'): Promise<void> => {
    const ids =
      action === 'approve'
        ? queuePosts.filter((post) => post.score <= approveThreshold).map((post) => post.id)
        : queuePosts.filter((post) => post.score >= removeThreshold).map((post) => post.id);

    if (ids.length === 0) {
      addToast(
        action === 'approve'
          ? 'No posts match auto-approve threshold'
          : 'No posts match auto-remove threshold',
        'info'
      );
      return;
    }

    setBulkLoading(action);
    try {
      const res = await apiClient.request<{ success: boolean; updated: number }>('/api/bulk-action', {
        method: 'POST',
        body: JSON.stringify({ type: 'BULK_ACTION', action, postIds: ids }),
      });
      const actioned = queuePosts.filter((post) => ids.includes(post.id));
      actioned.forEach((post) => appendAudit(post, action));
      removePostsFromQueue(ids);
      addToast(
        action === 'approve'
          ? `${res.updated} posts auto-approved`
          : `${res.updated} posts auto-removed`,
        'success'
      );
      void refreshStats();
    } catch {
      addToast('Auto action failed — try again', 'error');
    } finally {
      setBulkLoading(null);
    }
  };

  return (
    <main className="min-h-screen bg-[#0F1117] p-3 text-[#F1F5F9] md:p-5">
      <div className="mx-auto max-w-6xl overflow-hidden rounded-xl border border-[#2A2D3E] bg-[#0B0E16]">
        {accessState === 'checking' && (
          <div className="grid min-h-[50vh] place-items-center px-6 py-10 text-center">
            <div className="space-y-2">
              <p className="text-lg font-semibold">Checking moderator access...</p>
              <p className="text-sm text-[#64748B]">Please wait</p>
            </div>
          </div>
        )}
        {accessState === 'denied' && (
          <div className="grid min-h-[50vh] place-items-center px-6 py-10 text-center">
            <div className="space-y-2">
              <p className="text-lg font-semibold text-[#EF4444]">Moderator access required</p>
              <p className="text-sm text-[#64748B]">Only subreddit moderators can access Modecule dashboard.</p>
            </div>
          </div>
        )}
        {accessState === 'allowed' && (
          <>
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#22263A] px-4 py-3 md:px-5">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-extrabold tracking-[0.08em] text-[#7C5CFC]">MODECULE</h1>
            <span className="text-sm text-[#64748B]">r/modecule_dev</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <div className="grid h-8 w-8 place-items-center rounded-full border border-[#7C5CFC] text-xs text-[#C4B5FD]">RU</div>
            <p className="font-semibold">u/rusil4421</p>
          </div>
        </header>

        <section className="grid gap-2 border-b border-[#22263A] px-4 py-3 sm:grid-cols-2 lg:grid-cols-5 md:px-5">
          <StatCard value={String(stats.processed)} label="Processed" accent="text-[#F1F5F9]" />
          <StatCard value={String(stats.removed)} label="Removed today" accent="text-[#EF4444]" />
          <StatCard value={String(stats.approved)} label="Approved today" accent="text-[#22C55E]" />
          <StatCard value={String(stats.inQueue)} label="In queue" accent="text-[#EF4444]" pulse={stats.inQueue > 10} />
          <StatCard value={String(stats.reported)} label="Reported" accent="text-[#F59E0B]" />
        </section>

        <nav className="border-b border-[#22263A] px-4 md:px-5">
          <div className="flex flex-wrap gap-3">
            {tabs.map((tab) => (
              <button key={tab.key} className={`tab-btn ${activeTab === tab.key ? 'active' : ''}`} onClick={() => setActiveTab(tab.key)}>
                {tab.label}
              </button>
            ))}
          </div>
        </nav>

        <section key={activeTab} className="tab-fade px-4 py-4 md:px-5">
          {activeTab === 'priority' && (
            <div className="space-y-3 pb-20">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-2xl font-semibold">Case Feed ({sortedQueuePosts.length})</h2>
                <div className="flex items-center gap-2">
                  <select value={feedSort} onChange={(event) => setFeedSort(event.target.value as FeedSort)} className="min-w-52 rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-3 py-2 text-sm text-[#94A3B8] outline-none">
                    {sortOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <button type="button" onClick={selectAllVisible} className="rounded-md border border-[#7C5CFC] bg-[#1A1D27] px-3 py-2 text-sm text-[#C4B5FD] transition hover:brightness-110">
                    {allVisibleSelected ? 'Deselect all' : 'Select all'}
                  </button>
                  <button
                    type="button"
                    disabled={bulkLoading !== null}
                    onClick={() => void runAutoThresholdAction('approve')}
                    className="rounded-md bg-[#22C55E] px-3 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
                  >
                    {bulkLoading === 'approve' ? '...' : 'Auto Approve'}
                  </button>
                  <button
                    type="button"
                    disabled={bulkLoading !== null}
                    onClick={() => void runAutoThresholdAction('remove')}
                    className="rounded-md bg-[#EF4444] px-3 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
                  >
                    {bulkLoading === 'remove' ? '...' : 'Auto Remove'}
                  </button>
                </div>
              </div>

              {loadingQueue && (
                <div className="space-y-3">
                  <SkeletonCard />
                  <SkeletonCard />
                  <SkeletonCard />
                </div>
              )}

              {!loadingQueue && sortedQueuePosts.length === 0 && (
                <div className="stat-card grid place-items-center px-6 py-10 text-center">
                  <div className="mb-2 grid h-10 w-10 place-items-center rounded-full border border-[#2A2D3E] text-[#64748B]">✓</div>
                  <p className="text-lg font-semibold">Queue is clear — nothing to review</p>
                  <p className="mt-1 text-sm text-[#64748B]">New posts will appear here automatically</p>
                </div>
              )}

              {!loadingQueue && sortedQueuePosts.map((post) => {
                const checked = selectedIds.has(post.id);
                return (
                  <article key={post.id} className={`case-card hover-glow relative grid gap-4 p-3 sm:p-4 lg:grid-cols-[1fr_auto] ${post.difficulty === 'legendary' ? 'legendary-glow' : ''} ${checked ? 'border-l-[3px] border-l-[#7C5CFC] bg-[#22263a]' : ''}`}>
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <input type="checkbox" checked={checked} onChange={() => toggleSelect(post.id)} className="h-4 w-4 cursor-pointer accent-[#7C5CFC]" />
                        <DifficultyBadge difficulty={post.difficulty} />
                      </div>
                      <div>
                        <h3 className="text-xl font-semibold leading-tight">{post.title}</h3>
                        <p className="mt-1 text-sm text-[#64748B]">u/{post.author}</p>
                      </div>
                      <ScoreBar score={post.score} />
                      <div className="flex flex-wrap gap-2">
                        {post.reasons.map((reason) => (
                          <Chip key={`${post.id}-${reason}`} label={reason} />
                        ))}
                      </div>
                    </div>

                    <div className="relative flex items-start justify-end gap-2 text-sm lg:flex-col lg:text-right">
                      <button disabled={Boolean(processingIds[post.id])} className="action-link text-[#22C55E]" onClick={() => void runSingleAction(post, 'approve')}>Approve</button>
                      <button disabled={Boolean(processingIds[post.id])} className="action-link text-[#EF4444]" onClick={() => void runSingleAction(post, 'remove')}>Remove</button>
                      <button disabled={Boolean(processingIds[post.id])} className="action-link text-[#7C5CFC]" onClick={() => void runSingleAction(post, 'escalate')}>Escalate</button>
                    </div>
                  </article>
                );
              })}

              {selectedIds.size > 0 && (
                <div className="sticky bottom-3 z-20 rounded-lg border border-[#2A2D3E] bg-[#13151f] px-5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 text-sm">
                      <p className="font-semibold text-white">{selectedIds.size} cases selected</p>
                      <button className="text-[#64748B] hover:text-[#F1F5F9]" onClick={selectAllVisible}>{allVisibleSelected ? 'Deselect all' : 'Select all'}</button>
                      <button className="text-[#64748B] hover:text-[#F1F5F9]" onClick={clearSelection}>Clear selection</button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button disabled={bulkLoading !== null} onClick={() => void runBulkAction('approve')} className="rounded-lg bg-[#22C55E] px-3 py-2 text-sm font-semibold text-white">{bulkLoading === 'approve' ? '...' : 'Approve all'}</button>
                      <button disabled={bulkLoading !== null} onClick={() => void runBulkAction('remove')} className="rounded-lg bg-[#EF4444] px-3 py-2 text-sm font-semibold text-white">{bulkLoading === 'remove' ? '...' : 'Remove all'}</button>
                      <button disabled={bulkLoading !== null} onClick={() => void runBulkAction('escalate')} className="rounded-lg border border-[#7C5CFC] bg-transparent px-3 py-2 text-sm font-semibold text-[#C4B5FD]">{bulkLoading === 'escalate' ? '...' : 'Escalate all'}</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}


          {activeTab === 'escalated' && (
            <div className="space-y-3">
              {loadingEscalated && (
                <div className="space-y-3">
                  <SkeletonCard />
                  <SkeletonCard />
                </div>
              )}
              {!loadingEscalated && escalatedPosts.length === 0 && (
                <div className="stat-card grid place-items-center px-6 py-10 text-center">
                  <p className="text-lg font-semibold">No escalated posts</p>
                  <p className="mt-1 text-sm text-[#64748B]">Posts escalated for review will appear here</p>
                </div>
              )}
              {!loadingEscalated && escalatedPosts.map((post) => (
                <article key={post.id} className="case-card hover-glow grid gap-4 p-3 sm:p-4 lg:grid-cols-[1fr_auto]">
                  <div className="space-y-3">
                    <DifficultyBadge difficulty={post.difficulty} />
                    <div>
                      <h3 className="text-xl font-semibold leading-tight">{post.title}</h3>
                      <p className="mt-1 text-sm text-[#64748B]">u/{post.author}</p>
                    </div>
                    <ScoreBar score={post.score} />
                    <div className="flex flex-wrap gap-2">
                      {post.reasons.map((reason) => <Chip key={`${post.id}-${reason}`} label={reason} />)}
                    </div>
                  </div>
                  <div className="relative flex items-start justify-end gap-2 text-sm lg:flex-col lg:text-right">
                    <button disabled={Boolean(processingIds[post.id])} className="action-link text-[#22C55E]" onClick={() => void runEscalatedAction(post, 'approve')}>Approve</button>
                    <button disabled={Boolean(processingIds[post.id])} className="action-link text-[#EF4444]" onClick={() => void runEscalatedAction(post, 'remove')}>Remove</button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {activeTab === 'reported' && (
            <div className="space-y-3">
              {loadingReported && (
                <div className="space-y-3">
                  <SkeletonCard />
                  <SkeletonCard />
                  <SkeletonCard />
                </div>
              )}
              {!loadingReported && reportedPosts.length === 0 && (
                <div className="stat-card grid place-items-center px-6 py-10 text-center">
                  <p className="text-lg font-semibold">Queue is clear — nothing to review</p>
                  <p className="mt-1 text-sm text-[#64748B]">New posts will appear here automatically</p>
                </div>
              )}
              {!loadingReported && reportedPosts.map((post) => (
                <article key={post.id} className="case-card hover-glow grid gap-4 p-3 sm:p-4 lg:grid-cols-[1fr_auto]">
                  <div className="space-y-3">
                    <DifficultyBadge difficulty={post.difficulty} />
                    <div>
                      <h3 className="text-xl font-semibold leading-tight">{post.title}</h3>
                      <p className="mt-1 text-sm text-[#64748B]">u/{post.author}</p>
                    </div>
                    <ScoreBar score={post.score} />
                    <div className="flex flex-wrap gap-2">
                      {post.reasons.map((reason) => <Chip key={`${post.id}-${reason}`} label={reason} />)}
                    </div>
                  </div>
                  <div className="relative flex items-start justify-end gap-2 text-sm lg:flex-col lg:text-right">
                    <button className="action-link text-[#22C55E]" onClick={() => void runSingleAction(post, 'approve')}>Approve</button>
                    <button className="action-link text-[#EF4444]" onClick={() => void runSingleAction(post, 'remove')}>Remove</button>
                    <button className="action-link text-[#7C5CFC]" onClick={() => void runSingleAction(post, 'escalate')}>Escalate</button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {activeTab === 'audit' && (
            <div className="space-y-3">
              <div className="stat-card p-4">
                <input className="w-full rounded-lg border border-[#2A2D3E] bg-[#0F1117] px-3 py-2 text-sm outline-none placeholder:text-[#64748B] focus:border-[#7C5CFC]" placeholder="Filter by mod username or post title" value={auditFilter} onChange={(event) => setAuditFilter(event.target.value)} />
              </div>
              {filteredAudit.map((entry) => (
                <article key={`${entry.ts}-${entry.title}`} className="stat-card hover-glow p-4">
                  <p className="text-xs text-[#64748B]">{entry.ts} - <span className="text-[#7C5CFC]">{entry.mod}</span></p>
                  <h3 className="mt-1 font-semibold text-white">{entry.title}</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${entry.action === 'approved' ? 'bg-[#22C55E]/20 text-[#86EFAC]' : entry.action === 'removed' ? 'bg-[#EF4444]/20 text-[#FCA5A5]' : 'bg-[#7C5CFC]/20 text-[#C4B5FD]'}`}>{entry.action}</span>
                    <span className="rounded-full border border-[#2A2D3E] bg-[#0F1117] px-2 py-1 text-xs text-[#64748B]">Score {entry.score}</span>
                    {entry.reasons.map((reason) => <Chip key={`${entry.ts}-${reason}`} label={reason} />)}
                  </div>
                </article>
              ))}
            </div>
          )}

          {activeTab === 'rules' && (
            <div className="grid gap-3 lg:grid-cols-2">
              <section className="stat-card space-y-4 p-4">
                <SliderField label="Auto Approve Threshold" value={approveThreshold} onChange={setApproveThreshold} />
                <SliderField label="Auto Remove Threshold" value={removeThreshold} onChange={setRemoveThreshold} />
              </section>
              <section className="stat-card space-y-3 p-4">
                <label className="text-sm font-semibold">Community Rules (one per line)</label>
                <textarea className="min-h-44 w-full rounded-lg border border-[#2A2D3E] bg-[#0F1117] px-3 py-2 text-sm text-[#F1F5F9] outline-none placeholder:text-[#64748B] focus:border-[#7C5CFC]" value={rulesText} onChange={(event) => setRulesText(event.target.value)} />
                <button className="rounded-lg bg-[#7C5CFC] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110">Save Rules</button>
              </section>
            </div>
          )}
        </section>
          </>
        )}
      </div>

      <div className="fixed right-4 top-4 z-50 space-y-2">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-slide rounded-md px-3 py-2 text-sm text-white shadow-lg ${toast.tone === 'error' ? 'bg-[#7f1d1d]' : toast.tone === 'success' ? 'bg-[#14532d]' : 'bg-[#1f2937]'}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </main>
  );
};

const formatNow = (): string => {
  const now = new Date();
  return now.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const scoreToDifficulty = (score: number): Difficulty => {
  if (score < 0.3) {
    return 'easy';
  }
  if (score <= 0.6) {
    return 'medium';
  }
  if (score <= 0.85) {
    return 'hard';
  }
  return 'legendary';
};

const StatCard = ({ value, label, accent, pulse = false }: { value: string; label: string; accent: string; pulse?: boolean }) => (
  <div className={`stat-card hover-glow px-3 py-2.5 ${pulse ? 'queue-pulse' : ''}`}>
    <p className="text-xs text-[#64748B]">{label}</p>
    <p className={`mt-1 text-3xl leading-none font-bold ${accent}`}>{value}</p>
  </div>
);

const DifficultyBadge = ({ difficulty }: { difficulty: Difficulty }) => (
  <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${difficultyClass[difficulty]}`}>{difficultyText[difficulty]}</span>
);

const ScoreBar = ({ score }: { score: number }) => {
  const tone = score < 0.3 ? 'bg-[#22C55E]' : score <= 0.7 ? 'bg-[#F59E0B]' : 'bg-[#EF4444]';
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.16em]">
        <span className="text-[#22C55E]">0.00 Approveable</span>
        <span className="text-[#EF4444]">1.00 Reject</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-[#2A2D3E]">
        <div
          className={`h-full rounded-full transition-all duration-300 ${tone}`}
          style={{ width: `${Math.max(0, Math.min(100, score * 100))}%` }}
        />
      </div>
      <p className="mt-1 text-right text-xs text-[#64748B]">Reject chance: {score.toFixed(2)}</p>
    </div>
  );
};

const Chip = ({ label }: { label: string }) => (
  <span className="rounded-full border border-[#2A2D3E] bg-[#252A3A]/45 px-2 py-0.5 text-xs text-[#94A3B8]">{label}</span>
);

const SkeletonCard = () => (
  <div className="case-card p-4">
    <div className="skeleton-pulse h-5 w-32 rounded" />
    <div className="mt-3 skeleton-pulse h-6 w-3/4 rounded" />
    <div className="mt-2 skeleton-pulse h-4 w-1/3 rounded" />
    <div className="mt-4 skeleton-pulse h-2 w-full rounded" />
    <div className="mt-3 flex gap-2">
      <div className="skeleton-pulse h-5 w-20 rounded-full" />
      <div className="skeleton-pulse h-5 w-24 rounded-full" />
      <div className="skeleton-pulse h-5 w-16 rounded-full" />
    </div>
  </div>
);

const SliderField = ({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) => (
  <label className="block text-sm font-semibold">
    {label}
    <input type="range" min="0" max="1" step="0.01" value={value} onChange={(event) => onChange(Number.parseFloat(event.target.value))} className="modecule-slider mt-2 w-full" />
    <input type="number" min="0" max="1" step="0.01" value={value} onChange={(event) => onChange(Number.parseFloat(event.target.value) || 0)} className="mt-2 w-full rounded-lg border border-[#2A2D3E] bg-[#0F1117] px-3 py-2 text-sm" />
  </label>
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
