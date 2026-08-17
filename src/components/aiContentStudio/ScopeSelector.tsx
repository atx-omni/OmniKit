import type { OmniModel, OmniTopic } from '@/types';

export function ScopeSelector({
  models,
  topics,
  modelId,
  topicName,
  loadingModels,
  loadingTopics,
  disabled,
  onModelChange,
  onTopicChange,
  modelEmptyLabel = 'Choose a base model',
}: {
  models: OmniModel[];
  topics: OmniTopic[];
  modelId: string;
  topicName: string;
  loadingModels: boolean;
  loadingTopics: boolean;
  disabled: boolean;
  onModelChange: (value: string) => void;
  onTopicChange: (value: string) => void;
  modelEmptyLabel?: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-content-secondary">Base model</span>
        <select
          value={modelId}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={disabled || loadingModels}
          className="input-field"
        >
          <option value="">{loadingModels ? 'Loading models…' : modelEmptyLabel}</option>
          {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-content-secondary">Topic (optional)</span>
        <select
          value={topicName}
          onChange={(event) => onTopicChange(event.target.value)}
          disabled={disabled || !modelId || loadingTopics}
          className="input-field"
        >
          <option value="">{loadingTopics ? 'Loading topics…' : 'Model context only'}</option>
          {topics.map((topic) => <option key={topic.name} value={topic.name}>{topic.label || topic.name}</option>)}
        </select>
      </label>
    </div>
  );
}
