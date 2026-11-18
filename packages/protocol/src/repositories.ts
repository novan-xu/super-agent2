import { z } from "zod";

export const RepositoryName = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
  .refine((name) => !name.endsWith("/.") && !name.endsWith("/.."), { message: "is not a repository name" });
export type RepositoryName = z.infer<typeof RepositoryName>;
