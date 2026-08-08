import { aiPromptSecretFindingsShared } from '../../src/services/aiPromptSecurityShared';

export function aiPromptSecretFindings(prompt: string): string[] {
  return aiPromptSecretFindingsShared(prompt);
}

export function aiPromptSecurityError(prompt: string): string | null {
  const findings = aiPromptSecretFindings(prompt);
  if (findings.length === 0) return null;
  return `AI prompt rejected because it contains secret-shaped content (${findings.join(', ')}). Remove credentials from model context before continuing.`;
}
