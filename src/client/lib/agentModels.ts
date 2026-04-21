export type ProviderId = 'claude' | 'codex';

export type AgentModel = {
  id: string;
  label: string;
  hintKey: string;
};

export const MODEL_CATALOG: Record<ProviderId, AgentModel[]> = {
  claude: [
    { id: 'claude-opus-4-7', label: 'Opus 4.7', hintKey: 'agent.models.opus47' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6', hintKey: 'agent.models.opus46' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', hintKey: 'agent.models.sonnet46' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hintKey: 'agent.models.haiku45' },
  ],
  codex: [
    { id: 'gpt-5.4', label: 'GPT-5.4', hintKey: 'agent.models.gpt54' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', hintKey: 'agent.models.gpt53codex' },
  ],
};

export const DEFAULT_MODEL: Record<ProviderId, string> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
};
