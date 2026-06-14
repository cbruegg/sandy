import type { CoreStoresInput, CoreStoresResult } from "./types.js";
import { InMemorySessionStore } from "../session/in-memory-session-store.js";
import { TomlPersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import { JobApprovalStore } from "../jobs/job-approval-store.js";
import { JobStore } from "../jobs/job-store.js";
import { SkillService } from "../skills.js";

export function createCoreStoresLayer(input: CoreStoresInput): CoreStoresResult {
  const { config } = input;

  const sessionStore = new InMemorySessionStore();
  const persistentApprovalStore = new TomlPersistentApprovalStore(
    config.configFilePath,
    config.persistentMcpApprovals,
    config.persistentHttpApprovals,
    config.persistentMcpResourceApprovals,
    config.persistentHostDirectoryApprovals,
  );
  const jobApprovalStore = new JobApprovalStore(config.configDirectory);
  const skillService = new SkillService(config.configDirectory);
  const jobStore = new JobStore(config.configDirectory, skillService);

  const stop = async (): Promise<void> => {
    // Core stores have no async teardown.
  };

  return {
    name: "core-stores",
    sessionStore,
    persistentApprovalStore,
    jobApprovalStore,
    skillService,
    jobStore,
    stop,
  };
}