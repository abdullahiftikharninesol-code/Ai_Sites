import { useEffect, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import { attachmentUsageForPrompt, promptUsesImageAsReference, type ImageAttachment } from "./attachment-usage";

export { attachmentUsageForPrompt } from "./attachment-usage";
export type { ImageAttachment } from "./attachment-usage";

const supported = (file: File) =>
  ["image/png", "image/jpeg", "image/webp"].includes(file.type) && /\.(png|jpe?g|webp)$/i.test(file.name);

export function pastedImages(files: File[]): ImageAttachment[] {
  return files.filter((file) => ["image/png", "image/jpeg", "image/webp"].includes(file.type)).map((file, index) => ({
    file: new File([file], /\.(png|jpe?g|webp)$/i.test(file.name) ? file.name : `pasted-reference-${Date.now()}-${index}.${file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : "png"}`, { type: file.type }),
    usage: "REFERENCE",
  }));
}

function AttachmentPreview({ attachment, usage, onRemove, onToggle }: { attachment: ImageAttachment; usage: ImageAttachment["usage"]; onRemove: () => void; onToggle: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(attachment.file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [attachment.file]);
  return <div className="attachment-thumb">
    {url && <img src={url} alt={attachment.file.name} />}
    <button type="button" className="attachment-remove" aria-label={`Remove ${attachment.file.name}`} onClick={onRemove}><X size={11} /></button>
    <button type="button" className="attachment-usage" onClick={onToggle} aria-label={`${attachment.file.name}: ${usage === "REFERENCE" ? "design reference" : "site image"}. Click to change.`} title="Click to switch between design reference and site image">{usage === "REFERENCE" ? "Reference" : "Site image"}</button>
  </div>;
}

export function ImageAttachments({ attachments, setAttachments, prompt }: { attachments: ImageAttachment[]; setAttachments: (attachments: ImageAttachment[]) => void; prompt: string }) {
  const input = useRef<HTMLInputElement>(null);
  const add = (incoming: File[]) => {
    if (incoming.some((file) => !supported(file))) { toast.error("Use PNG, JPG, JPEG, or WEBP images only"); return; }
    const referencePrompt = promptUsesImageAsReference(prompt);
    setAttachments([...attachments, ...incoming.map((file): ImageAttachment => ({ file, usage: referencePrompt || /\b(screenshot|reference|mockup)\b/i.test(file.name) ? "REFERENCE" : "CONTENT" }))]);
  };
  return <div className="image-attachments">
    <input ref={input} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple onChange={(event) => { add(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
    <button type="button" className="attachment-button" onClick={() => input.current?.click()} aria-label="Attach images" title="Attach images"><Paperclip size={15} aria-hidden="true" /></button>
    {attachments.length > 0 && <><div className="attachment-list" aria-label={`${attachments.length} attached images`}>{attachments.map((attachment, index) => <AttachmentPreview key={`${attachment.file.name}-${attachment.file.size}-${index}`} attachment={attachment} usage={attachmentUsageForPrompt(attachment, prompt)} onRemove={() => setAttachments(attachments.filter((_, item) => item !== index))} onToggle={() => setAttachments(attachments.map((item, itemIndex) => itemIndex === index ? { ...item, usage: attachmentUsageForPrompt(item, prompt) === "REFERENCE" ? "CONTENT" : "REFERENCE", usageSelectedManually: true } : item))} />)}</div><span className="attachment-help">Reference guides the design; Site image appears on the page. Click a label to switch.</span></>}
  </div>;
}
