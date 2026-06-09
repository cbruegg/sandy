import type { ActiveTaskState, SessionState } from "../types.js";

export type SessionTaskRecord = {
  task: ActiveTaskState;
  location: "active" | "background";
};

export function findSessionTask(session: SessionState, taskId: string): SessionTaskRecord | null {
  if (session.activeTask?.taskId === taskId) {
    return {
      task: session.activeTask,
      location: "active",
    };
  }

  const index = session.backgroundJobTasks.findIndex((task) => task.taskId === taskId);
  if (index === -1) {
    return null;
  }

  const task = session.backgroundJobTasks[index];
  if (!task) {
    return null;
  }

  return {
    task,
    location: "background",
  };
}

export function removeSessionTask(session: SessionState, taskId: string): ActiveTaskState | null {
  if (session.activeTask?.taskId === taskId) {
    const task = session.activeTask;
    session.activeTask = null;
    return task;
  }

  const index = session.backgroundJobTasks.findIndex((task) => task.taskId === taskId);
  if (index === -1) {
    return null;
  }

  const [task] = session.backgroundJobTasks.splice(index, 1);
  return task ?? null;
}

export function promoteBackgroundJobTask(session: SessionState, taskId: string): ActiveTaskState {
  if (session.activeTask) {
    throw new Error(`Cannot promote task ${taskId} while another visible task is active.`);
  }

  const task = removeSessionTask(session, taskId);
  if (!task) {
    throw new Error(`Task ${taskId} is no longer active.`);
  }

  session.activeTask = task;
  return task;
}
