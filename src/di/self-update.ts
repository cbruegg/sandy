import type { SelfUpdateLayerInput, SelfUpdateLayerResult } from "./types.js";
import { SelfUpdateCoordinator } from "../update/self-update.js";
import { resolvePublishedUpdateSource } from "../build-metadata.js";
import { logger } from "../logger.js";

export function createSelfUpdateLayer(input: SelfUpdateLayerInput): SelfUpdateLayerResult {
  const { config, sessionStore, channel, shutdown } = input;

  const updateCoordinator = new SelfUpdateCoordinator({
    mode: config.updateMode,
    currentExecutablePath: process.execPath,
    currentArgs: process.argv.slice(1),
    currentWorkingDirectory: process.cwd(),
    updateSource: resolvePublishedUpdateSource(),
    canInstallUpdate: () => {
      const sessions = sessionStore.listSessions();
      const blockingSessions = sessions.filter((session) =>
        session.visibleTask !== null
        || session.backgroundJobTasks.length > 0
        || session.pendingShareDeletion !== null
        || session.pendingSkillArchiveRequest !== null);
      if (blockingSessions.length > 0) {
        logger.debug("update.blocked_by_sessions", {
          blockingCount: blockingSessions.length,
          totalCount: sessions.length,
          blockingSessions: blockingSessions.map((session) => ({
            chatId: session.chatId,
            hasVisibleTask: session.visibleTask !== null,
            backgroundJobTaskCount: session.backgroundJobTasks.length,
            hasPendingTaskSummary: session.pendingTaskSummary !== null,
            hasPendingShareDeletion: session.pendingShareDeletion !== null,
            hasPendingSkillArchiveRequest: session.pendingSkillArchiveRequest !== null,
          })),
        });
        return false;
      }
      return true;
    },
    notifyChats: async (message) => {
      const chatIds = Array.from(new Set(sessionStore.listSessions().map((session) => session.chatId)));
      await Promise.all(chatIds.map(async (chatId) => {
        try {
          await channel.sendText(chatId, message);
        } catch (error) {
          logger.warn("update.notification_failed", {
            chatId,
            message: error instanceof Error ? error.message : "Unknown update notification failure.",
          });
        }
      }));
    },
    prepareForRestart: shutdown,
  });

  const stop = (): Promise<void> => {
    updateCoordinator.stop();
    return Promise.resolve();
  };

  return {
    name: "self-update",
    updateCoordinator,
    stop,
  };
}