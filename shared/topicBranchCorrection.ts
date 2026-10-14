import type { BranchPreparationReceipt, TopicMigrationFile, TopicMigrationIssue, TopicMigrationRequest } from './topicMigration';

export interface TopicBranchValidation {
  status: 'not_run' | 'passed' | 'issues' | 'unavailable';
  checkedAt?: number;
  branchHash?: string;
  issues: Array<{ message: string; fileName?: string; warning: boolean }>;
  message?: string;
}

/** Separately approved corrections. Never reauthorizes an original migration. */
export interface TopicBranchCorrectionPlan {
  version: 1;
  id: string;
  revision: string;
  originPlanId: string;
  originJobId: string;
  predecessorId?: string;
  branch: BranchPreparationReceipt;
  request: TopicMigrationRequest;
  createdAt: number;
  expiresAt: number;
  files: TopicMigrationFile[];
  issues: TopicMigrationIssue[];
  noops: number;
  sourceDialect: string;
  targetDialect: string;
  status: 'ready' | 'blocked' | 'unchanged' | 'running' | 'applied' | 'partial' | 'uncertain' | 'canceled';
  jobId?: string;
  progress: string;
  outcomes: Array<{ fileName: string; status: 'pending' | 'writing' | 'applied' | 'unapplied' | 'divergent' | 'unknown' }>;
  filesVerified: boolean;
  mainUnchanged?: boolean;
  validation: TopicBranchValidation;
  contentValidation: TopicBranchValidation;
}
