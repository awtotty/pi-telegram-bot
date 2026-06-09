export type BotConfig = {
  telegram: {
    botToken?: string;
    allowedUsers: string[];
    offset?: number;
    recentSenders: Array<{ id: string; name: string; lastSeenAt: string }>;
  };
  selectedModel?: { provider: string; id: string };
  workspaceDir: string;
  piAgentDir: string;
  sessionDir: string;
  chatSessions: Record<string, string>;
};

export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_event'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type EventSink = (event: AgentEvent) => void;
