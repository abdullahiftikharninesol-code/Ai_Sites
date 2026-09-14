import { ApplicationError } from "../app/errors/application-error.js";
export interface SecurityScanFile {
  readonly path: string;
  readonly content?: string | Uint8Array;
}
const forbiddenNames = [
  "SITES_LOCAL_SECRET_MASTER_KEY",
  "SITES_JOB_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "KIMI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "DAYTONA_API_KEY",
];
const forbiddenFiles =
  /(^|\/)(?:auth|secrets?|runtime)(?:-[^/]*)?\.sqlite(?:-(?:wal|shm))?$|(^|\/)(?:\.env(?:\..*)?)$/i;
export class SiteArtifactSecurityScanner {
  scan(files: readonly SecurityScanFile[], kind: "source" | "deployment" = "source"): void {
    for (const file of files) {
      const path = file.path.replaceAll("\\", "/"),
        content =
          typeof file.content === "string"
            ? file.content
            : file.content
              ? new TextDecoder().decode(file.content)
              : "";
      if (forbiddenFiles.test(path) || forbiddenNames.some((name) => content.includes(name)))
        throw new ApplicationError(
          kind === "source"
            ? "SOURCE_SECURITY_VALIDATION_FAILED"
            : "DEPLOYMENT_SECURITY_VALIDATION_FAILED",
          `Artifact security validation failed for ${path}`,
          { metadata: { path } },
        );
    }
  }
}
