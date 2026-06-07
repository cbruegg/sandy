export type JobDefinition = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: JobSchedule;
  skillId: string;
  prompt?: string;
};

export type JobSchedule =
  | { kind: "one_shot"; runAt: string }
  | { kind: "cron"; expression: string; timezone?: string };

export type JobRuntimeState = {
  jobId: string;
  lastRunAt: string | null;
  lastTaskId: string | null;
};

export type JobsFile = {
  definitions: JobDefinition[];
  runtimeState: JobRuntimeState[];
};

type JobMutationOperation = "create" | "update" | "delete" | "enable" | "disable" | "run_now";

export type JobMutationRequest = {
  operation: JobMutationOperation;
  jobId: string;
  definition?: JobDefinition;
};
