export class TaskRegistry {
  private readonly taskChatIds = new Map<string, string>();

  register(taskId: string, chatId: string): void {
    this.taskChatIds.set(taskId, chatId);
  }

  unregister(taskId: string): void {
    this.taskChatIds.delete(taskId);
  }

  getChatId(taskId: string): string | undefined {
    return this.taskChatIds.get(taskId);
  }
}
