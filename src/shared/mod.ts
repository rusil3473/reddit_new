export type RiskLabel = 'low_risk' | 'borderline' | 'high_risk';
export type SuggestedAction = 'approve' | 'review' | 'remove';
export type ScoreSource = 'gemini' | 'gemini+learning' | 'safety_override' | 'siq_auto_approve';

export type ModerationRules = {
  autoApproveThreshold: number;
  autoRemoveThreshold: number;
  communityRules: string[];
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
