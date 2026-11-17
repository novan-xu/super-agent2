import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WorkSender, WorkTask, WritingTask } from "@super-agent2/protocol";
import { type WritingPlace, writingTaskText } from "./writing.js";

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
    ...task.issues.map((issue, index) => `${index + 1}. #${issue.number} ${issue.title} (${issue.url})`),
    "",
    `Hand back by writing the JSON file at: ${place.handback}`,
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
    `Hand back by writing the JSON file at ${place.handback} when the pull request is open, as described at the start.`,
    task.note === null ? "" : `\n${task.note}`,
  ]
    .join("\n")
    .trim();
}

export function continueText(task: WorkTask, place: BriefPlace, note: string): string {
  return [`[hub] ${note}`, "", `When you are done, hand back again by writing the JSON file at ${place.handback}.`].join("\n");
}

export function messageText(from: WorkSender, text: string): string {
  const who = from === "owner" ? "the owner" : from === "brain" ? "the brain" : "the hub";
  return `[Message from ${who}] ${text}`;
}

export function lostSessionNote(): string {
  return "An earlier worker on this ticket was cut off and its session could not be resumed. Work from earlier may already be in this folder, on the branch, and in an open pull request: check `git status`, `git log` and `gh pr list --head <branch>` first and continue from there.";
}

export const writerGuidanceFile = fileURLToPath(new URL("../guidance/WRITER.md", import.meta.url));

let writer: string | undefined;

export function writerGuidance(): string {
  writer ??= readFileSync(writerGuidanceFile, "utf8").trim();
  return writer;
}

export function writingBrief(task: WritingTask, place: WritingPlace): string {
  const parts = [writerGuidance(), writingTaskText(task, place)];
  if (task.note !== null) {
    parts.push(`# A note from the hub\n\n${task.note}`);
  }
  return parts.join("\n\n");
}

export function writingResumeText(task: WritingTask, place: WritingPlace): string {
  return [
    "[hub] Your previous turn was cut off because the machine's runner restarted. Continue the task from where you left off.",
    `Look at what is already in your output folder ${place.output} first.`,
    `Hand back by writing the JSON file at ${place.handback} when your result is in the output folder, as described at the start.`,
    task.note === null ? "" : `\n${task.note}`,
  ]
    .join("\n")
    .trim();
}

export function writingContinueText(place: WritingPlace, note: string): string {
  return [`[hub] ${note}`, "", `When you are done, hand back again by writing the JSON file at ${place.handback}.`].join("\n");
}

export function writingLostSessionNote(): string {
  return "An earlier worker on this task was cut off and its session could not be resumed. Work from earlier may already be in the output folder: look there first and continue from it.";
}
