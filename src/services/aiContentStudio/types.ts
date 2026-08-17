import type { DashboardFilter, DashboardTile } from '@/services/deckBuilder/types';

export type AIContentMode = 'review' | 'dashboard' | 'app' | 'report';

export interface AIContentAttachment {
  id: string;
  name: string;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'application/pdf';
  size: number;
  data: string;
}

export interface InspectedContentDashboard {
  id: string;
  name: string;
  folderPath?: string;
  connectionId?: string;
  tiles: DashboardTile[];
  filters: DashboardFilter[];
  topics: string[];
  /** Raw document/workbook/query model IDs retained for review evidence. */
  modelIds: string[];
  documentModelId?: string;
  workbookModelId?: string;
  queryModelIds?: string[];
  /** Exact canonical SHARED models that are eligible for the AI review. */
  eligibleModelIds?: string[];
  canonicalModelIdByDetectedId?: Record<string, string>;
  modelResolutionBlockedReason?: string;
  modelResolutionNotice?: string;
  documentModelReadError?: string;
  /** Canonical selected SHARED model, never a name-derived association. */
  modelId?: string;
}

export type AIContentAgentMode = AIContentMode;

export interface AIContentOneShotBrief {
  audience: string;
  objective: string;
  requiredContent: string;
  layoutAndInteractions: string;
  visualDirection: string;
  exclusions: string;
  acceptanceCriteria: string;
  additionalContext: string;
}

export type AIContentOneShotBriefField = keyof AIContentOneShotBrief;

export interface AIContentPromptInput {
  mode: AIContentAgentMode;
  contentName: string;
  brief: AIContentOneShotBrief;
  attachmentManifest: Array<Pick<AIContentAttachment, 'name' | 'contentType'>>;
  dashboard?: InspectedContentDashboard;
  reviewRenderAttachmentName?: string;
}

export interface AIContentDocumentReference {
  documentId: string;
  actionType: string;
  summary: string;
}

export type AIContentUnresolvedJobReason = 'poll-unavailable' | 'timeout' | 'result-unavailable';

export interface AIContentJobOutcome {
  jobId: string;
  state: 'COMPLETE';
  /**
   * COMPLETE is authoritative for the job lifecycle. The separate result read
   * is enrichment and can be unavailable even though Omni finished the job.
   */
  resultAvailability?: 'available' | 'unavailable';
  message: string;
  actionSummaries: string[];
  conversationId: string;
  chatUrl: string;
  documentReferences: AIContentDocumentReference[];
  artifactState:
    | 'returned-unverified'
    | 'reported-created-unverified'
    | 'creation-status-unverified'
    | 'not-returned';
  actionReviewIssues: string[];
}
