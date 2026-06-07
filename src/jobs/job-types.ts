import type { JobDefinition } from "./job-validation.js";

type JobMutationOperation = "create" | "update" | "delete" | "enable" | "disable" | "run_now";

export type JobMutationRequest = {
  operation: JobMutationOperation;
  jobId: string;
  definition?: JobDefinition;
};
