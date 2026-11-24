export type ImageAttachment = { file: File; usage: "REFERENCE" | "CONTENT"; usageSelectedManually?: boolean };

// An attachment is a website image ("CONTENT") unless the prompt clearly asks for
// a design reference. Asking to show the image on the site always wins, because a
// reference is only seen by the model and is never shipped with the website.
const DESIGN_REFERENCE_INTENT =
  /\b(?:references?|screenshots?|mockups?|wireframes?|inspiration|inspired by|match (?:this|the|that)|recreate|replicate|clone|copy (?:this|the|that) (?:layout|design|style|look)|(?:like|similar to) (?:this|the|that) (?:image|design|screenshot|layout|site|website|page)|based on (?:this|the|that) (?:attached )?(?:image|design|screenshot|layout|mockup)|using (?:this|the|that) (?:attached )?(?:design|screenshot|mockup|layout))\b/i;

const IMAGE = String.raw`(?:image|photo|picture|pic|logo|graphic|illustration|artwork)s?`;
const THIS_IMAGE = String.raw`(?:this|that|these|the|my|our|attached|uploaded|provided)\s+(?:(?!(?:references?|designs?|layouts?|styles?)\b)[\w-]+\s+){0,2}${IMAGE}`;
const PLACEMENT = String.raw`(?:hero|banner|header|background|backdrop|cover|gallery|slider|carousel)`;
const DISPLAY_INTENT = [
  /\bnot\s+(?:just\s+|only\s+|merely\s+)?(?:as|for)\s+(?:an?\s+|the\s+)?(?:design\s+|visual\s+|style\s+)?(?:reference|inspiration)\b/i,
  new RegExp(String.raw`\b(?:show|display|embed|showcase|feature|place|put|insert)\s+${THIS_IMAGE}\b`, "i"),
  new RegExp(String.raw`\b${THIS_IMAGE}\b[^.!?\n]{0,40}\b(?:in|on|as|into|for)\s+(?:(?:the|my|our|a|an)\s+)?${PLACEMENT}\b`, "i"),
  /\b(?:as|for)\s+(?:an?\s+|the\s+)?(?:actual\s+|real\s+)?(?:website|site|page)\s+(?:image|asset|media|photo)\b/i,
  new RegExp(String.raw`\b(?:as|for)\s+(?:the|my|our|a|an)\s+(?:${PLACEMENT}|main|featured)\s+(?:image|photo|picture)\b`, "i"),
];

export const promptShowsImageOnSite = (prompt: string) => DISPLAY_INTENT.some((pattern) => pattern.test(prompt));

export const promptUsesImageAsReference = (prompt: string) => DESIGN_REFERENCE_INTENT.test(prompt) && !promptShowsImageOnSite(prompt);

export function attachmentUsageForPrompt(attachment: ImageAttachment, prompt: string): ImageAttachment["usage"] {
  if (attachment.usageSelectedManually) return attachment.usage;
  if (promptShowsImageOnSite(prompt)) return "CONTENT";
  return promptUsesImageAsReference(prompt) || /\b(screenshot|reference|mockup)\b/i.test(attachment.file.name)
    ? "REFERENCE"
    : "CONTENT";
}
