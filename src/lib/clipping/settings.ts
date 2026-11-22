import { z } from "zod";

/** Output settings for a rendered clip. Shared by file and YouTube clip jobs. */
export const renderSettingsSchema = z.object({
  aspect: z.enum(["9:16", "1:1", "16:9"]).default("9:16"),
  reframe: z.enum(["auto", "crop", "blur", "fit"]).default("auto"),
  focusX: z.number().min(0).max(1).default(0.5),
  quality: z.enum(["720p", "1080p"]).default("720p"),
  captions: z.boolean().default(true),
  captionStyle: z.enum(["bold", "highlight", "minimal"]).default("bold"),
  uppercase: z.boolean().default(true),
  normalizeAudio: z.boolean().default(true),
});
