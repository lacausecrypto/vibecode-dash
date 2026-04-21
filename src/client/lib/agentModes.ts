// Client thin re-export. The truth lives in src/shared/agentModes.ts so the
// server can assemble the prompt with the same mode metadata.
export {
  AGENT_MODES,
  AGENT_MODE_LIST,
  STARTER_PROMPTS,
  getAgentMode,
  getAgentModeList,
  getStarterPrompts,
  type AgentMode,
  type AgentModeConfig,
  type StarterPrompt,
} from '../../shared/agentModes';
