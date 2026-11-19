import { z } from "zod";

export const FolderPath = z.string().trim().min(1).max(4096).refine((path) => !/[\0\r\n]/.test(path));

export const StorageSettings = z.strictObject({
  projectsDir: FolderPath.optional(),
  artifactsDir: FolderPath.optional(),
});
export type StorageSettings = z.infer<typeof StorageSettings>;

export const storageFolders = ["projectsDir", "artifactsDir"] as const;
export type StorageFolder = (typeof storageFolders)[number];

export const StorageProblem = z.enum(["not-absolute", "not-found", "unreachable"]);
export type StorageProblem = z.infer<typeof StorageProblem>;

const FolderReport = z.object({ path: FolderPath, problem: StorageProblem.optional() });

export const StorageReport = z.object({
  projectsDir: FolderReport,
  artifactsDir: FolderReport.extend({ reachable: z.boolean().optional() }),
});
export type StorageReport = z.infer<typeof StorageReport>;

export const SetRunnerStorage = z.object({ type: z.literal("storage.set"), settings: StorageSettings });
