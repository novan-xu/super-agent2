import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Attachment, attachmentLine, type TaskAssignment, type WorkSender, type WorkTask } from "@super-agent2/protocol";
import { assignmentText, type TaskPlace } from "./task.js";

export const workerGuidanceFile = fileURLToPath(new URL("../guidance/WORKER.md", import.meta.url));

let guidance: string | undefined;

export function workerGuidance(): string {
  guidance ??= readFileSync(workerGuidanceFile, "utf8").trim();
  return guidance;
}

export interface BriefPlace {
  readonly worktree: string;
  readonly base: string;
  readonly handback: string;
}

export function taskText(task: WorkTask, place: BriefPlace): string {
  return [
    "# Your task",
    "",
    `Repository: ${task.repository}`,
    `Working folder: ${place.worktree}`,
    `Branch: ${task.branch}, made from ${place.base}, which is the default branch`,
    `Chain: ${task.title}`,
    "",
    "Issues, in working order:",
    ...task.issues.map((issue, index) => `${index + 1}. #${issue.number} ${issue.title} (${issue.url})${(task.merged ?? []).includes(issue.number) ? ", already closed by a merged pull request" : ""}`),
    "",
    `Hand in each pull request by writing the JSON file at: ${place.handback}`,
  ].join("\n");
}

export function brief(task: WorkTask, place: BriefPlace): string {
  const parts = [workerGuidance(), taskText(task, place)];
  if (task.note !== null) {
    parts.push(`# A note from the hub\n\n${task.note}`);
  }
  return parts.join("\n\n");
}

export function resumeText(task: WorkTask, place: BriefPlace): string {
  return [
    "[hub] Your previous turn was cut off because the machine's runner restarted. Continue the task from where you left off.",
    "Check `git status` and `git log` in your working folder first, and look at what is already on the branch and in any open pull request from it.",
    `Hand in by writing the JSON file at ${place.handback} when a pull request is open, as described at the start.`,
    task.note === null ? "" : `\n${task.note}`,
  ]
    .join("\n")
    .trim();
}

export function continueText(task: WorkTask, place: BriefPlace, note: string): string {
  return [`[hub] ${note}`, "", `Hand in the pull request by writing the JSON file at ${place.handback}, as before.`].join("\n");
}

export interface LeftoverPlace {
  readonly branch: string;
  readonly commit: string;
  readonly carried: boolean;
  readonly into: string;
  readonly base: string;
}

export function leftoverText(leftover: LeftoverPlace): string {
  const kept = `the local branch ${leftover.branch} (commit ${leftover.commit})`;
  return leftover.carried
    ? `[hub] Uncommitted changes were found in your folder when it moved to the new branch ${leftover.into}. They were carried over: they are uncommitted changes on ${leftover.into} now, and a copy is kept on ${kept}. Check that they still belong in the next pull request.`
    : `[hub] Uncommitted changes were found in your folder when it moved to the new branch ${leftover.into}. They did not apply cleanly on the updated ${leftover.base}, so ${leftover.into} starts clean, and they are kept on ${kept}. Take what you need from there, for example with \`git cherry-pick --no-commit ${leftover.commit}\` or \`git checkout ${leftover.commit} -- <path>\`.`;
}

export interface AttachedFile {
  readonly attachment: Attachment;
  readonly path: string;
}

export function messageText(from: WorkSender, text: string, files: readonly AttachedFile[] = []): string {
  const who = from === "owner" ? "the owner" : from === "brain" ? "the brain" : "the hub";
  if (files.length === 0) {
    return `[Message from ${who}] ${text}`;
  }
  return [
    `[Message from ${who}] ${text}`.trimEnd(),
    `[hub] ${files.length === 1 ? "A file is" : `${files.length} files are`} attached to this message, outside your worktree so they are never committed by accident:`,
    ...files.map((file) => `- ${attachmentLine(file.attachment, file.path)}`),
    "Images are also shown to you with the message when your program can take them. Read any attached file with your own tools at its path; copy it into the repository only if the task needs it there.",
  ].join("\n");
}

export function lostSessionNote(): string {
  return "An earlier worker on this ticket was cut off and its session could not be resumed. Work from earlier may already be in this folder, on the branch, and in an open pull request: check `git status`, `git log` and `gh pr list --head <branch>` first and continue from there.";
}

export const taskGuidanceFile = fileURLToPath(new URL("../guidance/TASK.md", import.meta.url));

let taskGuide: string | undefined;

export function taskGuidance(): string {
  taskGuide ??= readFileSync(taskGuidanceFile, "utf8").trim();
  return taskGuide;
}

export function taskBrief(task: TaskAssignment, place: TaskPlace): string {
  const parts = [taskGuidance(), assignmentText(task, place)];
  if (task.note !== null) {
    parts.push(`# A note from the hub\n\n${task.note}`);
  }
  return parts.join("\n\n");
}

export function taskResumeText(task: TaskAssignment, place: TaskPlace): string {
  return [
    "[hub] Your previous turn was cut off because the machine's runner restarted. Continue the task from where you left off.",
    `Look at what is already in your output folder ${place.output}${place.checkout === null ? "" : ` and in the checkout ${place.checkout}`} first, and check the state of anything you were changing on this machine before you do it again.`,
    `Hand back by writing the JSON file at ${place.handback} when you are done or know the task failed, as described at the start.`,
    task.note === null ? "" : `\n${task.note}`,
  ]
    .join("\n")
    .trim();
}

export function taskContinueText(place: TaskPlace, note: string): string {
  return [`[hub] ${note}`, "", `When you are done, hand back again by writing the JSON file at ${place.handback}.`].join("\n");
}

export function taskLostSessionNote(): string {
  return "An earlier worker on this task was cut off and its session could not be resumed. Work from earlier may already be done: look in the output folder, in the checkout if there is one, and at the state of what the task changes on this machine, and continue from there.";
}
