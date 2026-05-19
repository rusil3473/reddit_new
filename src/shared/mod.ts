export type ContentKind = 'post' | 'comment';

export type QueueItem = {
  itemId: string;
  subredditId: string;
  subredditName: string;
  authorId: string;
  authorName: string;
  contentKind: ContentKind;
  contentText: string;
  permalink: string;
  createdAt: number;
  reportCount: number;
  riskScore: number;
  explanation: string;
  status: 'queued' | 'auto_approved' | 'auto_removed' | 'reviewed';
  modAction?: 'approve' | 'remove';
  claimedBy?: string;
  claimedAt?: number;
  signals: SignalBreakdown;
};

export type SignalBreakdown = {
  accountAgeDays: number;
  accountAgeRisk: number;
  karma: number;
  karmaRisk: number;
  regexMatches: string[];
  regexRisk: number;
  reputation: number;
  reputationRisk: number;
  priorFlags: number;
  priorFlagsRisk: number;
  reportVolumeRisk: number;
  llmRisk: number;
  llmReasons: string[];
  crossPostAnomalyRisk: number;
  totalScore: number;
};

export type DashboardResponse = {
  type: 'dashboard';
  queueLength: number;
  highRiskCount: number;
  topViolationTypes: Array<{ name: string; count: number }>;
  items: QueueItem[];
};

export type RuleConfig = {
  autoRemoveThreshold: number;
  autoApproveThreshold: number;
  regexRules: string[];
};

export type ClaimRequest = {
  itemId: string;
};

export type BulkActionRequest = {
  action: 'approve' | 'remove';
  maxItems: number;
  minConfidence: number;
};

export type ActionResponse = {
  status: 'ok';
  updated: number;
};

export type EnqueuePayload = {
  itemId: string;
  subredditId: string;
  subredditName: string;
  authorId: string;
  authorName: string;
  contentKind: ContentKind;
  contentText: string;
  permalink: string;
  createdAt: number;
  reportCount: number;
};
