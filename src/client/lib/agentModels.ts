export type ProviderId = 'claude' | 'codex';

export type AgentModel = {
  id: string;
  label: string;
  hintKey: string;
};

/**
 * Fallback catalog used only when `/api/agent/models` fetch fails. Kept in
 * sync with the server-side STATIC_CATALOG (src/server/lib/agentModels.ts)
 * so offline/error rendering matches the normal merged-catalog shape.
 */
export const MODEL_CATALOG: Record<ProviderId, AgentModel[]> = {
  claude: [
    { id: 'claude-opus-4-7', label: 'Opus 4.7', hintKey: 'agent.models.opus47' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6', hintKey: 'agent.models.opus46' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', hintKey: 'agent.models.sonnet46' },
    { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', hintKey: '' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hintKey: 'agent.models.haiku45' },
    { id: 'opus', label: 'Opus (latest)', hintKey: '' },
    { id: 'sonnet', label: 'Sonnet (latest)', hintKey: '' },
    { id: 'haiku', label: 'Haiku (latest)', hintKey: '' },
  ],
  codex: [
    { id: 'gpt-5.5', label: 'GPT-5.5', hintKey: '' },
    { id: 'gpt-5.4', label: 'GPT-5.4', hintKey: 'agent.models.gpt54' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', hintKey: 'agent.models.gpt53codex' },
    { id: 'gpt-5.3', label: 'GPT-5.3', hintKey: '' },
    { id: 'gpt-5.2', label: 'GPT-5.2', hintKey: '' },
    { id: 'gpt-5.1', label: 'GPT-5.1', hintKey: '' },
    { id: 'gpt-5', label: 'GPT-5', hintKey: '' },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex', hintKey: '' },
    { id: 'gpt-5-mini', label: 'GPT-5 Mini', hintKey: '' },
    { id: 'gpt-5-nano', label: 'GPT-5 Nano', hintKey: '' },
    { id: 'o4', label: 'o4', hintKey: '' },
    { id: 'o4-mini', label: 'o4 Mini', hintKey: '' },
    { id: 'o3', label: 'o3', hintKey: '' },
    { id: 'o3-mini', label: 'o3 Mini', hintKey: '' },
    { id: 'gpt-4o', label: 'GPT-4o', hintKey: '' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini', hintKey: '' },
  ],
};

export const DEFAULT_MODEL: Record<ProviderId, string> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
};
