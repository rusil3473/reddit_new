export type RiskLabel = 'low_risk' | 'borderline' | 'high_risk';
export type SuggestedAction = 'approve' | 'review' | 'remove';
export type ScoreSource = 'gemini' | 'gemini+learning' | 'safety_override' | 'siq_auto_approve';

export type ModerationRules = {
  autoApproveThreshold: number;
  autoRemoveThreshold: number;
  banEvasionThreshold: number;
  communityRules: string[];
};

// BanEvasionMatch is attached to a ScoreRecord when a newly-scored post's
// fingerprint matches a stored "banned signal" (a post previously removed
// by mods in this subreddit) at or above the moderator-configured threshold.
// It is informational: mods still decide the action.
export type BanEvasionMatch = {
  matchedAuthor: string;
  matchedPostId: string;
  similarity: number;   // 0..1, raw Jaccard score
  threshold: number;    // threshold value at scoring time, for audit replay
  timestamp: number;
};

// BannedUserMatch is attached to a ScoreRecord when a newly-scored post's
// fingerprint matches the historical removed-content corpus of a user that
// was explicitly banned by a moderator from the Modecule dashboard. Distinct
// from BanEvasionMatch in that the underlying corpus is per-banned-user,
// not aggregated removal history. Stronger signal — the matched user is
// known to be banned by this subreddit's mods.
export type BannedUserMatch = {
  matchedAuthor: string;       // the banned user's username
  matchedPostId: string;       // one of the banned user's prior removed posts
  similarity: number;          // 0..1, raw Jaccard score
  threshold: number;           // threshold at scoring time
  timestamp: number;
};

// BannedSignal is one entry in the per-subreddit banned_signals:{subredditId}
// corpus used for ban-evasion similarity matching. We append on every mod
// removal regardless of author.
export type BannedSignal = {
  authorName: string;
  postId: string;
  title: string;
  fingerprint: string[];
  timestamp: number;
};

// BannedUserSignal is one entry in the per-subreddit
// banned_user_signals:{subredditId} corpus. Each entry is a removed post
// belonging to a user who was explicitly banned via the Modecule dashboard.
// Seeded from author:actions:* history at ban time and trimmed when the
// user is unbanned.
export type BannedUserSignal = {
  bannedUserName: string;
  postId: string;
  title: string;
  fingerprint: string[];
  timestamp: number;
};

// BannedUserRecord is the per-subreddit list entry tracking which users a
// mod has banned via the Modecule dashboard. We keep this list so we can
// (a) seed the signals corpus on ban, (b) clear it on unban, and (c) show
// "Ban / Unban" affordance on the user-stats panel.
export type BannedUserRecord = {
  authorName: string;
  bannedAt: number;
  bannedBy: string;          // moderator username
  durationDays?: number;     // omitted = permanent
  reason?: string;
};

export type ScoreRecord = {
  postId: string;
  subredditId: string;
  title: string;
  body: string;
  authorName: string;
  accountAgeDays: number;
  karma: number;
  reportCount: number;
  priorFlagsInSub: number;
  score: number;
  label: RiskLabel;
  reasons: string[];
  suggested_action: SuggestedAction;
  createdAt: number;
  signalCountAtScoring?: number;
  confidence?: number;
  scoreSource?: ScoreSource;
  banEvasionMatch?: BanEvasionMatch;
  bannedUserMatch?: BannedUserMatch;
};

export type ReportMeta = {
  postId: string;
  subredditId: string;
  title: string;
  authorName: string;
  firstReportedAt: number;
  lastReportedAt: number;
  reportCount: number;
  status: 'active' | 'processed';
  processedAt?: number;
  processedAction?: 'approve' | 'remove';
};

export type AuditEntry = {
  postId: string;
  subredditId: string;
  action: 'approve' | 'remove' | 'claim' | 'escalate' | 'score';
  modId: string;
  timestamp: number;
  score: number;
  reasons: string[];
  postTitle: string;
  scoreSource?: ScoreSource;
};

export type QueueItem = {
  postId: string;
  subredditId: string;
  title: string;
  authorName: string;
  reportCount: number;
  score: number;
  label: RiskLabel;
  reasons: string[];
  suggested_action: SuggestedAction;
  claimedBy?: string;
};

export type SummaryStats = {
  totalProcessed: number;
  removedToday: number;
  approvedToday: number;
  queueCount: number;
  reportedCount: number;
};

export type ScoreContentRequest = {
  postId: string;
  title: string;
  body: string;
  authorName: string;
  accountAgeDays: number;
  karma: number;
  reportCount: number;
  priorFlagsInSub: number;
};

export type ScoreContentResponse = {
  success: boolean;
  record: ScoreRecord;
};

export type ActionRequest = {
  postId: string;
  subredditId: string;
  modId: string;
  reason: string;
};

export type ActionResponse = {
  success: boolean;
  error?: string;
};

export type DashboardResponse = {
  success: boolean;
  summary: SummaryStats;
  queue: QueueItem[];
};

export type ReportedPostRow = {
  meta: ReportMeta;
  score?: ScoreRecord;
};

export type ReportedPostsResponse = {
  success: boolean;
  posts: ReportedPostRow[];
};

export type AuditResponse = {
  success: boolean;
  entries: AuditEntry[];
};

export type BulkPreviewResponse = {
  success: boolean;
  candidates: QueueItem[];
};

export type BulkApplyResponse = {
  success: boolean;
  updated: number;
};

export type RulesResponse = {
  success: boolean;
  rules: ModerationRules;
};
