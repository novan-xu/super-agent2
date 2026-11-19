import { z } from "zod";

export const ExtraMcpServer = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/).refine((name) => name !== "hub"),
  url: z.url({ protocol: /^https?$/ }).refine((value) => { const url = new URL(value); return url.username === "" && url.password === "" && url.search === "" && url.hash === ""; }),
  token: z.string().min(1),
});
export type ExtraMcpServer = z.infer<typeof ExtraMcpServer>;
