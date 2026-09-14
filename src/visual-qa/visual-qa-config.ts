import { STANDARD_VIEWPORTS, type ViewportPreset } from "./visual-qa-types.js";
export type ScreenshotRetentionMode = "FINAL_ONLY" | "ALL_ATTEMPTS";
export interface VisualQAConfig {
  readonly enabled: boolean;
  readonly viewports: readonly ViewportPreset[];
  readonly maxRepairAttempts: number;
  readonly passScore: number;
  readonly screenshotRetentionMode: ScreenshotRetentionMode;
  readonly strict: boolean;
}
const number = (value: string | undefined, fallback: number) =>
  value === undefined ? fallback : Number(value);
export function loadVisualQAConfig(env: NodeJS.ProcessEnv = process.env): VisualQAConfig {
  const [desktop, tablet, mobile] = STANDARD_VIEWPORTS;
  return {
    enabled: env.VISUAL_QA_ENABLED !== "false",
    viewports: [
      {
        ...desktop!,
        width: number(env.VISUAL_QA_DESKTOP_WIDTH, desktop!.width),
        height: number(env.VISUAL_QA_DESKTOP_HEIGHT, desktop!.height),
      },
      {
        ...tablet!,
        width: number(env.VISUAL_QA_TABLET_WIDTH, tablet!.width),
        height: number(env.VISUAL_QA_TABLET_HEIGHT, tablet!.height),
      },
      {
        ...mobile!,
        width: number(env.VISUAL_QA_MOBILE_WIDTH, mobile!.width),
        height: number(env.VISUAL_QA_MOBILE_HEIGHT, mobile!.height),
      },
    ],
    maxRepairAttempts: number(env.MAX_VISUAL_REPAIR_ATTEMPTS, 1),
    passScore: number(env.VISUAL_QA_PASS_SCORE, 90),
    screenshotRetentionMode:
      env.SCREENSHOT_RETENTION_MODE === "ALL_ATTEMPTS" ? "ALL_ATTEMPTS" : "FINAL_ONLY",
    strict: env.VISUAL_QA_STRICT === "true",
  };
}
