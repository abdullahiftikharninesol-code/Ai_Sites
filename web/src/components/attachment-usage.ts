export type ImageAttachment = { file: File; usage: "REFERENCE" | "CONTENT"; usageSelectedManually?: boolean };

export const promptUsesImageAsReference = (prompt: string) =>
  /\b(reference|screenshot|mockup|match (?:this|the)|recreate|replicate|like (?:this|the) (?:image|design|screenshot)|based on (?:this|the) (?:attached )?(?:image|design|screenshot)|using (?:this|the) (?:attached )?(?:image|design|screenshot))\b/i.test(prompt);

export function attachmentUsageForPrompt(attachment: ImageAttachment, prompt: string): ImageAttachment["usage"] {
  if (attachment.usageSelectedManually) return attachment.usage;
  return promptUsesImageAsReference(prompt) || /\b(screenshot|reference|mockup)\b/i.test(attachment.file.name)
    ? "REFERENCE"
    : "CONTENT";
}
