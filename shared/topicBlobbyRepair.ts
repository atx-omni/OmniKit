import type { BranchPreparationReceipt, TopicMigrationRequest } from './topicMigration';
import type { TopicBranchValidation } from './topicBranchCorrection';

export interface TopicBlobbyFinding {
  code: string;
  severity: 'blocker' | 'warning';
  message: string;
  fileName?: string;
}

/** A separately reviewed branch repair; never a publication or query-acceptance receipt. */
export interface TopicBlobbyRepair {
  version: 1;
  id: string;
  revision: string;
  originPlanId: string;
  originJobId: string;
  predecessorId?: string;
  request: TopicMigrationRequest;
  branch: BranchPreparationReceipt;
  mode: 'api' | 'native';
  status: 'ready' | 'running' | 'uncertain' | 'review' | 'needs_input' | 'accepted' | 'canceled';
  createdAt: number;
  expiresAt: number;
  progress: string;
  nativePrompt: string;
  /** Copyable context is bound to one observed branch and validation snapshot. */
  nativePromptSnapshot?: { branchHash: string; generatedAt: number; validationCheckedAt?: number };
  sourceDialect: string;
  targetDialect: string;
  scopeFiles: string[];
  changes: Array<{ fileName: string; before: string | null; after: string | null }>;
  findings: TopicBlobbyFinding[];
  validation: TopicBranchValidation;
  mainUnchanged?: boolean;
  branchHash?: string;
  remoteJobId?: string;
  jobId?: string;
  acceptedAt?: number;
  acceptedBranchHash?: string;
  /** Server-derived eligibility; a new pass still needs explicit approval and fresh live evidence. */
  canPrepareNext?: boolean;
}
