import { z } from "zod";

export const uiConfigFile = ".superagent2/ui.json";
export const screenshotBytes = 2 * 1024 * 1024;
export const screenshotLimit = 16;
export const screenshotWidths = ["phone", "desktop"] as const;

export const ScreenshotView = z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]+$/u);
export const ScreenshotName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.(png|jpe?g)$/i)
  .refine((name) => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(name));
export const ScreenshotType = z.enum(["image/png", "image/jpeg"]);
export type ScreenshotType = z.infer<typeof ScreenshotType>;

const ScreenshotLabel = z.object({
  view: ScreenshotView,
  width: z.enum(screenshotWidths),
  phase: z.enum(["before", "after"]),
});
export const HandbackScreenshot = ScreenshotLabel.extend({ file: ScreenshotName });
export type HandbackScreenshot = z.infer<typeof HandbackScreenshot>;

export const ScreenshotFile = ScreenshotLabel.extend({
  name: ScreenshotName,
  size: z.number().int().positive().max(screenshotBytes),
  mediaType: ScreenshotType,
});
export type ScreenshotFile = z.infer<typeof ScreenshotFile>;

export const HeadCommit = z.string().regex(/^[a-f0-9]{40}$/);
export const ScreenshotSet = z.object({
  head: HeadCommit,
  images: z.array(ScreenshotFile).max(screenshotLimit),
  newViews: z.array(ScreenshotView).max(screenshotLimit),
});
export type ScreenshotSet = z.infer<typeof ScreenshotSet>;

export const ScreenshotReport = z.object({
  ticket: z.number().int().positive(),
  pullRequest: z.number().int().positive(),
  images: ScreenshotSet.shape.images,
});
export type ScreenshotReport = z.infer<typeof ScreenshotReport>;

export function screenshotImage(data: Uint8Array, mediaType: ScreenshotType): boolean {
  if (mediaType === "image/jpeg") {
    return data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255 && data.at(-2) === 255 && data.at(-1) === 217;
  }
  return data.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every((byte, index) => data[index] === byte);
}
