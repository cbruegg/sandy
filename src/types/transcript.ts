type TranscriptRole = "user" | "assistant" | "system";

export type TranscriptEntry = {
  role: TranscriptRole;
  kind: string;
  timestamp: string;
  text?: string;
  metadata?: Record<string, string | boolean>;
};
