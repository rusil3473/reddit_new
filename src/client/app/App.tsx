import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '../lib/apiClient';
import type {
  AuditItem,
  FeedSort,
  ModAction,
  QueuePost,
  QueueResponse,
  StatsResponse,
  TabKey,
} from './types';
import {
  actionLabels,
  sortOptions,
  tabs,
} from './constants';
import { formatNow } from './utils';
import { Chip } from './components/Chip';
import { ConfirmDialog } from './components/ConfirmDialog';
import { PostCard } from './components/PostCard';
import { ScoreBar } from './components/ScoreBar';
import { SkeletonCard } from './components/SkeletonCard';
import { SliderField } from './components/SliderField';
import { StatCard } from './components/StatCard';
import { useToasts } from './hooks/useToasts';
import { useAccessGate } from './hooks/useAccessGate';
import { useUserStats } from './hooks/useUserStats';

export const App = () => {
  const [activeTab, setActiveTab] = useState<TabKey>('priority');
  const [queuePosts, setQueuePosts] = useState<QueuePost[]>([]);
  const [reportedPosts, setReportedPosts] = useState<QueuePost[]>([]);
  const [processedPosts, setProcessedPosts] = useState<QueuePost[]>([]);
  const [escalatedPosts, setEscalatedPosts] = useState<QueuePost[]>([]);
  const [loadingEscalated, setLoadingEscalated] = useState(true);
  const [auditLog, setAuditLog] = useState<AuditItem[]>([]);
  const [stats, setStats] = useState({ processed: 0, removed: 0, approved: 0, inQueue: 0, reported: 0 });
  const [feedSort, setFeedSort] = useState<FeedSort>('newest');
  const [escalatedSort, setEscalatedSort] = useState<FeedSort>('risk_desc');
  const [reportedSort, setReportedSort] = useState<FeedSort>('risk_desc');
  const [processedSort, setProcessedSort] = useState<FeedSort>('newest');
  const [userApprovedSort, setUserApprovedSort] = useState<FeedSort>('newest');
  const [userRemovedSort, setUserRemovedSort] = useState<FeedSort>('newest');
  const [auditFilter, setAuditFilter] = useState('');
  const [approveThreshold, setApproveThreshold] = useState(0.15);
  const [removeThreshold, setRemoveThreshold] = useState(0.85);
  const [banEvasionThreshold, setBanEvasionThreshold] = useState(0.6);
  const [rulesText, setRulesText] = useState('Be civil\nNo direct threats\nNo promotional spam\nRespect reporting process');
  const [savingRules, setSavingRules] = useState(false);
  const [backfillingBanSignals, setBackfillingBanSignals] = useState(false);
  const [banDialogOpen, setBanDialogOpen] = useState(false);
  const [banDurationDays, setBanDurationDays] = useState<number | ''>(''); // '' = permanent
  const [banReason, setBanReason] = useState('');
  const [banSubmitting, setBanSubmitting] = useState(false);
  const [unbanDialogOpen, setUnbanDialogOpen] = useState(false);
  const [unbanSubmitting, setUnbanSubmitting] = useState(false);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [rescoring, setRescoring] = useState<Record<string, boolean>>({});
  const [loadingReported, setLoadingReported] = useState(true);
  const [loadingProcessed, setLoadingProcessed] = useState(true);
  const [processingIds, setProcessingIds] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState<ModAction | null>(null);
  const { toasts, addToast } = useToasts();
  const { accessState, checkAccess } = useAccessGate();
  const {
    viewingUser,
    userStats,
    loadingUserStats,
    userTab,
    setUserTab,
    openUserStats,
    reloadUserStats,
    closeUserStats,
  } = useUserStats({ onError: (msg) => addToast(msg, 'error') });
  const [reportsReceivedSort, setReportsReceivedSort] = useState<'count' | 'score' | 'recent'>('recent');

  const sendQueueMessage = async (): Promise<QueueResponse> => {
    return apiClient.request<QueueResponse>('/api/queue');
  };

  const sendStatsMessage = async (): Promise<StatsResponse> => {
    return apiClient.request<StatsResponse>('/api/stats');
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

  const rescorePost = async (postId: string): Promise<void> => {
    setRescoring((prev) => ({ ...prev, [postId]: true }));
    try {
      const res = await apiClient.request<{ success: boolean; post: { id: string; score: number; reasons: string[]; label: string } }>('/api/rescore', { method: 'POST', body: JSON.stringify({ postId }) });
      setQueuePosts((prev) => prev.map((p) => p.id === postId ? { ...p, score: res.post.score, reasons: res.post.reasons } : p));
      addToast('Rescored successfully', 'success');
    } catch {
      addToast('Rescore failed', 'error');
    } finally {
      setRescoring((prev) => ({ ...prev, [postId]: false }));
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

  const refreshProcessed = async (): Promise<void> => {
    setLoadingProcessed(true);
    try {
      const res = await apiClient.request<{ success: boolean; posts: Array<{ meta: { postId: string; title: string; authorName: string; reportCount: number; lastReportedAt: number; processedAction?: string }; score?: { score: number; reasons: string[] } }> }>('/api/reported-posts?page=1&pageSize=50&sort=recent&status=processed');
      const mapped = res.posts.map((row) => {
        const score = row.score?.score ?? 0.5;
        return {
          id: row.meta.postId,
          title: row.meta.title,
          author: row.meta.authorName,
          score,
          reasons: row.score?.reasons ?? [row.meta.processedAction ?? 'reviewed'],
          reportCount: row.meta.reportCount,
          createdAt: new Date(row.meta.lastReportedAt).toISOString(),
          type: 'post' as const,
        };
      });
      setProcessedPosts(mapped);
    } catch {
      setProcessedPosts([]);
    } finally {
      setLoadingProcessed(false);
    }
  };

  const refreshAudit = async (): Promise<void> => {
    try {
      const res = await apiClient.request<{ success: boolean; entries: Array<{ postId: string; postTitle: string; action: string; modId: string; timestamp: number; score: number; reasons: string[] }> }>('/api/audit?page=1&pageSize=50');
      if (!res.entries) {
        return;
      }
      const sorted = [...res.entries].sort((a, b) => b.timestamp - a.timestamp);
      const mapped = sorted.map((entry) => ({
        postId: entry.postId,
        ts: new Date(entry.timestamp).toLocaleString('en-US', { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        mod: entry.modId.startsWith('u/') ? entry.modId : `u/${entry.modId}`,
        title: entry.postTitle,
        action: (entry.action === 'approve' ? 'approved' : entry.action === 'remove' ? 'removed' : 'escalated') as AuditItem['action'],
        score: entry.score.toFixed(2),
        reasons: entry.reasons,
      }));
      setAuditLog(mapped);
    } catch {
      addToast('Audit log fetch failed', 'error');
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

  type RulesPayload = {
    autoApproveThreshold: number;
    autoRemoveThreshold: number;
    banEvasionThreshold: number;
    communityRules: string[];
  };

  const loadRules = async (): Promise<void> => {
    try {
      const res = await apiClient.request<{ success: boolean; rules: RulesPayload }>('/api/rules');
      if (!res.success || !res.rules) return;
      setApproveThreshold(res.rules.autoApproveThreshold);
      setRemoveThreshold(res.rules.autoRemoveThreshold);
      setBanEvasionThreshold(res.rules.banEvasionThreshold);
      setRulesText(res.rules.communityRules.join('\n'));
    } catch {
      // first-load failure is non-fatal; defaults already in state
    }
  };

  const saveRules = async (): Promise<void> => {
    setSavingRules(true);
    try {
      const communityRules = rulesText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      await apiClient.request<{ success: boolean }>('/api/rules', {
        method: 'POST',
        body: JSON.stringify({
          autoApproveThreshold: approveThreshold,
          autoRemoveThreshold: removeThreshold,
          banEvasionThreshold: banEvasionThreshold,
          communityRules,
        }),
      });
      addToast('Rules saved', 'success');
    } catch {
      addToast('Failed to save rules', 'error');
    } finally {
      setSavingRules(false);
    }
  };

  const runBackfillBanSignals = async (): Promise<void> => {
    setBackfillingBanSignals(true);
    try {
      const res = await apiClient.request<{ success: boolean; added: number; skipped: number }>(
        '/api/admin/backfill-banned-signals',
        { method: 'POST' }
      );
      if (res.success) {
        addToast(`Backfill complete: +${res.added} added, ${res.skipped} skipped`, 'success');
      } else {
        addToast('Backfill failed', 'error');
      }
    } catch {
      addToast('Backfill failed', 'error');
    } finally {
      setBackfillingBanSignals(false);
    }
  };

  const submitBanUser = async (): Promise<void> => {
    if (!viewingUser) return;
    setBanSubmitting(true);
    try {
      const body: { username: string; durationDays?: number; reason?: string } = {
        username: viewingUser,
      };
      if (typeof banDurationDays === 'number' && banDurationDays > 0) {
        body.durationDays = banDurationDays;
      }
      const trimmedReason = banReason.trim();
      if (trimmedReason.length > 0) {
        body.reason = trimmedReason;
      }
      const res = await apiClient.request<{ success: boolean; seeded: number }>(
        '/api/ban-user',
        { method: 'POST', body: JSON.stringify(body) }
      );
      if (res.success) {
        addToast(`Banned u/${viewingUser} (${res.seeded} signals seeded)`, 'success');
        setBanDialogOpen(false);
        setBanDurationDays('');
        setBanReason('');
        await reloadUserStats();
        void refreshQueue();
      } else {
        addToast('Ban failed', 'error');
      }
    } catch {
      addToast('Ban failed', 'error');
    } finally {
      setBanSubmitting(false);
    }
  };

  const submitUnbanUser = async (): Promise<void> => {
    if (!viewingUser) return;
    setUnbanSubmitting(true);
    try {
      const res = await apiClient.request<{ success: boolean; cleared: number }>(
        '/api/unban-user',
        { method: 'POST', body: JSON.stringify({ username: viewingUser }) }
      );
      if (res.success) {
        addToast(`Unbanned u/${viewingUser} (${res.cleared} signals cleared)`, 'success');
        setUnbanDialogOpen(false);
        await reloadUserStats();
        void refreshQueue();
      } else {
        addToast('Unban failed', 'error');
      }
    } catch {
      addToast('Unban failed', 'error');
    } finally {
      setUnbanSubmitting(false);
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
        void refreshProcessed();
        void refreshEscalated();
        void refreshAudit();
        void refreshStats();
        void loadRules();
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
    if (feedSort === 'risk_desc') { copy.sort((a, b) => b.score - a.score); return copy; }
    if (feedSort === 'risk_asc') { copy.sort((a, b) => a.score - b.score); return copy; }
    copy.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return copy;
  }, [feedSort, queuePosts]);

  const sortPosts = (posts: QueuePost[], sort: FeedSort): QueuePost[] => {
    const copy = [...posts];
    if (sort === 'risk_desc') return copy.sort((a, b) => b.score - a.score);
    if (sort === 'risk_asc') return copy.sort((a, b) => a.score - b.score);
    return copy.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  };

  const sortedEscalated = useMemo(() => sortPosts(escalatedPosts, escalatedSort), [escalatedSort, escalatedPosts]);
  const sortedReported = useMemo(() => sortPosts(reportedPosts, reportedSort), [reportedSort, reportedPosts]);
  const sortedProcessed = useMemo(() => sortPosts(processedPosts, processedSort), [processedSort, processedPosts]);

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
        postId: post.id,
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
      void refreshAudit();
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
      void refreshAudit();
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
      void refreshAudit();
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
      void refreshAudit();
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
        {viewingUser ? (
          <div className="p-4 md:p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => closeUserStats()} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-3 py-1.5 text-sm text-[#94A3B8] hover:text-white">← Back</button>
              <h2 className="text-2xl font-bold">u/{viewingUser}</h2>
              {userStats?.isBanned && (
                <span className="rounded-full border border-[#EF4444]/40 bg-[#EF4444]/15 px-2 py-0.5 text-xs font-semibold text-[#FCA5A5]">
                  Banned
                </span>
              )}
              <div className="ml-auto">
                {userStats && (userStats.isBanned ? (
                  <button
                    type="button"
                    onClick={() => setUnbanDialogOpen(true)}
                    disabled={loadingUserStats}
                    className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-3 py-1.5 text-sm text-[#94A3B8] transition hover:text-white disabled:opacity-50"
                  >
                    Unban user
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setBanDialogOpen(true)}
                    disabled={loadingUserStats}
                    className="rounded-md border border-[#EF4444]/40 bg-[#EF4444]/15 px-3 py-1.5 text-sm font-semibold text-[#FCA5A5] transition hover:brightness-110 disabled:opacity-50"
                  >
                    Ban user
                  </button>
                ))}
              </div>
            </div>
            {loadingUserStats && <div className="space-y-3"><SkeletonCard /><SkeletonCard /></div>}
            {!loadingUserStats && userStats && (
              <>
                <section className="grid gap-2 sm:grid-cols-3">
                  <StatCard value={String(userStats.counts.approved)} label="Approved" accent="text-[#22C55E]" />
                  <StatCard value={String(userStats.counts.removed)} label="Removed" accent="text-[#EF4444]" />
                  <StatCard value={String(userStats.counts.reportsReceived)} label="Reports Received" accent="text-[#F59E0B]" />
                </section>

                <nav className="border-b border-[#22263A]">
                  <div className="flex gap-3">
                    <button className={`tab-btn ${userTab === 'approved' ? 'active' : ''}`} onClick={() => setUserTab('approved')}>Approved ({userStats.posts.approved.length})</button>
                    <button className={`tab-btn ${userTab === 'removed' ? 'active' : ''}`} onClick={() => setUserTab('removed')}>Removed ({userStats.posts.removed.length})</button>
                    <button className={`tab-btn ${userTab === 'reportsReceived' ? 'active' : ''}`} onClick={() => setUserTab('reportsReceived')}>Reports Received ({userStats.reportedPosts.length})</button>
                  </div>
                </nav>

                {userTab === 'approved' && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2"><button type="button" onClick={() => void reloadUserStats()} disabled={loadingUserStats} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-2 py-1.5 text-sm text-[#94A3B8] transition hover:text-white disabled:opacity-50">↻ Refresh</button><select value={userApprovedSort} onChange={(e) => setUserApprovedSort(e.target.value as FeedSort)} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-3 py-1.5 text-sm text-[#94A3B8] outline-none"><option value="risk_desc">Risk score ↓</option><option value="risk_asc">Risk score ↑</option><option value="newest">Newest</option></select></div>
                    {[...userStats.posts.approved].sort((a, b) => userApprovedSort === 'risk_desc' ? b.score - a.score : userApprovedSort === 'risk_asc' ? a.score - b.score : b.timestamp - a.timestamp).map((p) => (
                      <article key={p.postId} className="case-card p-3 grid gap-3 lg:grid-cols-[1fr_auto]">
                        <div className="space-y-2">
                          <h4 className="font-semibold">{p.title}</h4>
                          <ScoreBar score={p.score} />
                          <div className="flex flex-wrap gap-2">
                            {p.reasons.map((r) => <Chip key={`${p.postId}-${r}`} label={r} />)}
                          </div>
                          <p className="text-xs text-[#64748B]">{new Date(p.timestamp).toLocaleString()}</p>
                        </div>
                        <div className="flex items-start justify-end">
                          <button type="button" disabled={Boolean(processingIds[p.postId])} className="action-link text-[#7C5CFC]" onClick={async () => {
                            setProcessingIds((prev) => ({ ...prev, [p.postId]: true }));
                            try { await apiClient.request<{ success: boolean }>('/api/mod-action', { method: 'POST', body: JSON.stringify({ type: 'MOD_ACTION', action: 'escalate', postId: p.postId }) }); addToast('Escalated', 'success'); void refreshEscalated(); } catch { addToast('Escalate failed', 'error'); }
                            finally { setProcessingIds((prev) => ({ ...prev, [p.postId]: false })); }
                          }}>Escalate</button>
                        </div>
                      </article>
                    ))}
                    {userStats.posts.approved.length === 0 && <p className="text-sm text-[#64748B]">No approved posts.</p>}
                  </div>
                )}

                {userTab === 'removed' && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2"><button type="button" onClick={() => void reloadUserStats()} disabled={loadingUserStats} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-2 py-1.5 text-sm text-[#94A3B8] transition hover:text-white disabled:opacity-50">↻ Refresh</button><select value={userRemovedSort} onChange={(e) => setUserRemovedSort(e.target.value as FeedSort)} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-3 py-1.5 text-sm text-[#94A3B8] outline-none"><option value="risk_desc">Risk score ↓</option><option value="risk_asc">Risk score ↑</option><option value="newest">Newest</option></select></div>
                    {[...userStats.posts.removed].sort((a, b) => userRemovedSort === 'risk_desc' ? b.score - a.score : userRemovedSort === 'risk_asc' ? a.score - b.score : b.timestamp - a.timestamp).map((p) => (
                      <article key={p.postId} className="case-card p-3 grid gap-3 lg:grid-cols-[1fr_auto]">
                        <div className="space-y-2">
                          <h4 className="font-semibold">{p.title}</h4>
                          <ScoreBar score={p.score} />
                          <div className="flex flex-wrap gap-2">
                            {p.reasons.map((r) => <Chip key={`${p.postId}-${r}`} label={r} />)}
                          </div>
                          <p className="text-xs text-[#64748B]">{new Date(p.timestamp).toLocaleString()}</p>
                        </div>
                        <div className="flex items-start justify-end">
                          <button type="button" disabled={Boolean(processingIds[p.postId])} className="action-link text-[#7C5CFC]" onClick={async () => {
                            setProcessingIds((prev) => ({ ...prev, [p.postId]: true }));
                            try { await apiClient.request<{ success: boolean }>('/api/mod-action', { method: 'POST', body: JSON.stringify({ type: 'MOD_ACTION', action: 'escalate', postId: p.postId }) }); addToast('Escalated', 'success'); void refreshEscalated(); } catch { addToast('Escalate failed', 'error'); }
                            finally { setProcessingIds((prev) => ({ ...prev, [p.postId]: false })); }
                          }}>Escalate</button>
                        </div>
                      </article>
                    ))}
                    {userStats.posts.removed.length === 0 && <p className="text-sm text-[#64748B]">No removed posts.</p>}
                  </div>
                )}

                {userTab === 'reportsReceived' && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => void reloadUserStats()} disabled={loadingUserStats} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-2 py-1.5 text-sm text-[#94A3B8] transition hover:text-white disabled:opacity-50">↻ Refresh</button>
                      <select value={reportsReceivedSort} onChange={(e) => setReportsReceivedSort(e.target.value as 'count' | 'score' | 'recent')} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-3 py-2 text-sm text-[#94A3B8] outline-none">
                        <option value="recent">Sort by: Recent</option>
                        <option value="count">Sort by: Report count</option>
                        <option value="score">Sort by: Risk score</option>
                      </select>
                    </div>
                    {[...userStats.reportedPosts].sort((a, b) => reportsReceivedSort === 'count' ? b.reportCount - a.reportCount : reportsReceivedSort === 'score' ? b.score - a.score : b.lastReportedAt - a.lastReportedAt).map((p) => (
                      <article key={p.postId} className="case-card p-3 grid gap-3 lg:grid-cols-[1fr_auto]">
                        <div className="space-y-2">
                          <h4 className="font-semibold">{p.title}</h4>
                          <ScoreBar score={p.score} />
                          <div className="flex flex-wrap gap-2">
                            {p.reasons.map((r) => <Chip key={`${p.postId}-${r}`} label={r} />)}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-[#64748B]">
                            <span>Reports: {p.reportCount}</span>
                            <span>Status: {p.status}</span>
                            <span>{new Date(p.lastReportedAt).toLocaleString()}</span>
                          </div>
                        </div>
                        <div className="flex items-start justify-end">
                          <button type="button" disabled={Boolean(processingIds[p.postId])} className="action-link text-[#7C5CFC]" onClick={async () => {
                            setProcessingIds((prev) => ({ ...prev, [p.postId]: true }));
                            try { await apiClient.request<{ success: boolean }>('/api/mod-action', { method: 'POST', body: JSON.stringify({ type: 'MOD_ACTION', action: 'escalate', postId: p.postId }) }); addToast('Escalated', 'success'); void refreshEscalated(); } catch { addToast('Escalate failed', 'error'); }
                            finally { setProcessingIds((prev) => ({ ...prev, [p.postId]: false })); }
                          }}>Escalate</button>
                        </div>
                      </article>
                    ))}
                    {userStats.reportedPosts.length === 0 && <p className="text-sm text-[#64748B]">No reports received.</p>}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <>
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#22263A] px-4 py-3 md:px-5">
          <h1 className="text-2xl font-extrabold tracking-[0.08em] text-[#7C5CFC]">MODECULE</h1>
          <span className="text-sm text-[#64748B]">r/modecule_dev</span>
        </header>

        <section className="grid gap-2 border-b border-[#22263A] px-4 py-3 sm:grid-cols-2 lg:grid-cols-7 md:px-5">
          <StatCard value={String(stats.processed)} label="Processed" accent="text-[#F1F5F9]" />
          <StatCard value={String(stats.removed)} label="Removed" accent="text-[#EF4444]" />
          <StatCard value={String(stats.approved)} label="Approved" accent="text-[#22C55E]" />
          <StatCard value={String(queuePosts.length)} label="In queue" accent="text-[#EF4444]" pulse={queuePosts.length > 10} />
          <StatCard value={String(escalatedPosts.length)} label="Escalated" accent="text-[#7C5CFC]" />
          <StatCard value={String(processedPosts.length)} label="Processed Reports" accent="text-[#64748B]" />
          <StatCard value={String(reportedPosts.length)} label="Reported Queue" accent="text-[#F59E0B]" />
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
                <div className="flex items-center gap-2">
                  <h2 className="text-2xl font-semibold">Case Feed ({sortedQueuePosts.length})</h2>
                  <button type="button" onClick={() => void refreshQueue()} disabled={loadingQueue} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-2 py-1.5 text-sm text-[#94A3B8] transition hover:text-white disabled:opacity-50">↻ Refresh</button>
                </div>
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
                  <PostCard
                    key={post.id}
                    post={post}
                    checkbox={{ checked, onToggle: () => toggleSelect(post.id) }}
                    actions={['approve', 'remove', 'escalate', 'rescore']}
                    processing={Boolean(processingIds[post.id])}
                    rescoring={Boolean(rescoring[post.id])}
                    onAuthorClick={(author) => void openUserStats(author)}
                    onAction={(kind) => {
                      if (kind === 'rescore') void rescorePost(post.id);
                      else void runSingleAction(post, kind);
                    }}
                  />
                );
              })}

              {selectedIds.size > 0 && (
                <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-[#2A2D3E] bg-[#13151f] px-5 py-3">
                  <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
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
              <div className="flex items-center gap-2"><h2 className="text-lg font-semibold">Escalated Queue</h2><button type="button" onClick={() => void refreshEscalated()} disabled={loadingEscalated} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-2 py-1.5 text-sm text-[#94A3B8] transition hover:text-white disabled:opacity-50">↻ Refresh</button><select value={escalatedSort} onChange={(e) => setEscalatedSort(e.target.value as FeedSort)} className="ml-auto rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-3 py-1.5 text-sm text-[#94A3B8] outline-none"><option value="risk_desc">Risk score ↓</option><option value="risk_asc">Risk score ↑</option><option value="newest">Newest</option></select></div>
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
              {!loadingEscalated && sortedEscalated.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  actions={['approve', 'remove', 'rescore']}
                  processing={Boolean(processingIds[post.id])}
                  rescoring={Boolean(rescoring[post.id])}
                  onAuthorClick={(author) => void openUserStats(author)}
                  onAction={(kind) => {
                    if (kind === 'rescore') void rescorePost(post.id);
                    else if (kind === 'approve' || kind === 'remove') void runEscalatedAction(post, kind);
                  }}
                />
              ))}
            </div>
          )}

          {activeTab === 'reported' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2"><h2 className="text-lg font-semibold">Reported Posts</h2><button type="button" onClick={() => void refreshReported()} disabled={loadingReported} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-2 py-1.5 text-sm text-[#94A3B8] transition hover:text-white disabled:opacity-50">↻ Refresh</button><select value={reportedSort} onChange={(e) => setReportedSort(e.target.value as FeedSort)} className="ml-auto rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-3 py-1.5 text-sm text-[#94A3B8] outline-none"><option value="risk_desc">Risk score ↓</option><option value="risk_asc">Risk score ↑</option><option value="newest">Newest</option></select></div>
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
              {!loadingReported && sortedReported.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  actions={['approve', 'remove', 'escalate']}
                  processing={Boolean(processingIds[post.id])}
                  onAuthorClick={(author) => void openUserStats(author)}
                  onAction={(kind) => {
                    if (kind === 'approve' || kind === 'remove' || kind === 'escalate') {
                      void runSingleAction(post, kind);
                    }
                  }}
                />
              ))}
            </div>
          )}

          {activeTab === 'processed' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2"><h2 className="text-lg font-semibold">Processed Reports</h2><button type="button" onClick={() => void refreshProcessed()} disabled={loadingProcessed} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-2 py-1.5 text-sm text-[#94A3B8] transition hover:text-white disabled:opacity-50">↻ Refresh</button><select value={processedSort} onChange={(e) => setProcessedSort(e.target.value as FeedSort)} className="ml-auto rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-3 py-1.5 text-sm text-[#94A3B8] outline-none"><option value="risk_desc">Risk score ↓</option><option value="risk_asc">Risk score ↑</option><option value="newest">Newest</option></select></div>
              {loadingProcessed && (
                <div className="space-y-3">
                  <SkeletonCard />
                  <SkeletonCard />
                  <SkeletonCard />
                </div>
              )}
              {!loadingProcessed && processedPosts.length === 0 && (
                <div className="stat-card grid place-items-center px-6 py-10 text-center">
                  <p className="text-lg font-semibold">No processed reports yet</p>
                  <p className="mt-1 text-sm text-[#64748B]">Approved or removed reports will appear here</p>
                </div>
              )}
              {!loadingProcessed && sortedProcessed.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  actions={['escalate']}
                  processing={Boolean(processingIds[post.id])}
                  onAuthorClick={(author) => void openUserStats(author)}
                  onAction={(kind) => {
                    if (kind === 'escalate') void runSingleAction(post, 'escalate');
                  }}
                />
              ))}
            </div>
          )}

          {activeTab === 'audit' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2"><h2 className="text-lg font-semibold">Audit Log</h2><button type="button" onClick={() => void refreshAudit()} className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-2 py-1.5 text-sm text-[#94A3B8] transition hover:text-white disabled:opacity-50">↻ Refresh</button></div>
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
                    {entry.action !== 'escalated' && (
                      <button type="button" disabled={Boolean(processingIds[entry.postId])} className="ml-auto rounded-md border border-[#7C5CFC] px-2 py-1 text-xs text-[#C4B5FD] hover:brightness-110 disabled:opacity-50" onClick={async () => {
                        setProcessingIds((prev) => ({ ...prev, [entry.postId]: true }));
                        try {
                          await apiClient.request<{ success: boolean }>('/api/mod-action', { method: 'POST', body: JSON.stringify({ type: 'MOD_ACTION', action: 'escalate', postId: entry.postId }) });
                          addToast('Escalated', 'success');
                          void refreshAudit();
                          void refreshEscalated();
                        } catch { addToast('Escalate failed', 'error'); }
                        finally { setProcessingIds((prev) => ({ ...prev, [entry.postId]: false })); }
                      }}>Escalate</button>
                    )}
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
                <SliderField label="Ban Evasion Threshold" value={banEvasionThreshold} onChange={setBanEvasionThreshold} />
                <p className="text-xs text-[#64748B]">
                  When a new post's title + body matches a previously-removed post's content above this similarity, mods are alerted. Higher = stricter (fewer alerts). Default 0.6.
                </p>
                <div className="border-t border-[#22263A] pt-3">
                  <button
                    type="button"
                    onClick={() => void runBackfillBanSignals()}
                    disabled={backfillingBanSignals}
                    className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-3 py-1.5 text-sm text-[#94A3B8] transition hover:text-white disabled:opacity-50"
                  >
                    {backfillingBanSignals ? 'Backfilling…' : 'Backfill ban-evasion corpus from history'}
                  </button>
                  <p className="mt-1 text-xs text-[#64748B]">
                    One-shot: scans existing per-author action history and seeds the ban-evasion corpus from prior removals. Idempotent — safe to re-run.
                  </p>
                </div>
              </section>
              <section className="stat-card space-y-3 p-4">
                <label className="text-sm font-semibold">Community Rules (one per line)</label>
                <textarea className="min-h-44 w-full rounded-lg border border-[#2A2D3E] bg-[#0F1117] px-3 py-2 text-sm text-[#F1F5F9] outline-none placeholder:text-[#64748B] focus:border-[#7C5CFC]" value={rulesText} onChange={(event) => setRulesText(event.target.value)} />
                <button
                  type="button"
                  onClick={() => void saveRules()}
                  disabled={savingRules}
                  className="rounded-lg bg-[#7C5CFC] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
                >
                  {savingRules ? 'Saving…' : 'Save Rules'}
                </button>
              </section>
            </div>
          )}
        </section>
          </>
        )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={banDialogOpen}
        title={viewingUser ? `Ban u/${viewingUser}?` : 'Ban user?'}
        description={
          <>
            <p>
              This will ban the user on Reddit and seed the ban-evasion corpus
              from their previously-removed posts in this subreddit.
            </p>
            <p className="mt-2 text-xs text-[#64748B]">
              The Reddit ban happens first — if it fails (e.g. permissions),
              no local state is changed.
            </p>
          </>
        }
        confirmLabel="Ban user"
        tone="danger"
        busy={banSubmitting}
        onCancel={() => {
          if (banSubmitting) return;
          setBanDialogOpen(false);
          setBanDurationDays('');
          setBanReason('');
        }}
        onConfirm={() => void submitBanUser()}
      >
        <label className="block text-sm font-semibold text-[#F1F5F9]">
          Duration (days)
          <input
            type="number"
            min={0}
            max={999}
            placeholder="Leave empty for permanent"
            value={banDurationDays === '' ? '' : banDurationDays}
            onChange={(event) => {
              const v = event.target.value;
              if (v === '') {
                setBanDurationDays('');
                return;
              }
              const n = Number.parseInt(v, 10);
              if (Number.isFinite(n)) setBanDurationDays(Math.max(0, Math.min(999, n)));
            }}
            className="mt-1 w-full rounded-md border border-[#2A2D3E] bg-[#0F1117] px-3 py-2 text-sm text-[#F1F5F9] outline-none placeholder:text-[#64748B] focus:border-[#7C5CFC]"
          />
          <span className="mt-1 block text-xs font-normal text-[#64748B]">
            Empty or 0 = permanent ban. Max 999 days.
          </span>
        </label>
        <label className="block text-sm font-semibold text-[#F1F5F9]">
          Reason (optional)
          <textarea
            value={banReason}
            onChange={(event) => setBanReason(event.target.value)}
            placeholder="Visible in the modlog"
            rows={2}
            maxLength={300}
            className="mt-1 w-full rounded-md border border-[#2A2D3E] bg-[#0F1117] px-3 py-2 text-sm text-[#F1F5F9] outline-none placeholder:text-[#64748B] focus:border-[#7C5CFC]"
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={unbanDialogOpen}
        title={viewingUser ? `Unban u/${viewingUser}?` : 'Unban user?'}
        description={
          <p>
            This will unban the user on Reddit and clear their entries from
            the ban-evasion corpus, so future scoring stops matching against
            this user.
          </p>
        }
        confirmLabel="Unban user"
        tone="primary"
        busy={unbanSubmitting}
        onCancel={() => {
          if (unbanSubmitting) return;
          setUnbanDialogOpen(false);
        }}
        onConfirm={() => void submitUnbanUser()}
      />

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
