import { ApplicationError } from "../../app/errors/application-error.js";
import type { SiteCoderFileBundle } from "../../cli/runtime/site-coder-file-bundle.js";
import { validateReferenceInteractions, validateStaticFragmentNavigation } from "../../cli/runtime/reference-interaction-validator.js";
import type { ExecutionProvider } from "../../execution/execution-provider.js";
import type { AssetManifest } from "../assets/asset-domain.js";
import { validateRequiredUserAssetReferences } from "../assets/asset-reference-validator.js";

export const USABLE_GENERATION_GUIDANCE = "DELIVERY PRIORITIES: Produce a coherent, buildable React website. Implement the user's requested content as fully as possible while prioritizing working pages, primary navigation and responsive layout. Use supported reusable controls. Displayed primary navigation must reach real destinations. Prefer working interactions over decorative controls; never invent successful payments, email delivery or backend integrations. Never claim that every requirement was verified.";

/** Read-only diagnostics: incomplete prompt features do not consume AI repair calls.
 * Source/import/security checks, actual builds and primary navigation remain gates. */
export function generationInteractionAdvisories(bundle: SiteCoderFileBundle): readonly { readonly check: string; readonly message: string }[] {
  const findings: { check: string; message: string }[] = [];
  for (const validate of [() => validateStaticFragmentNavigation(bundle), () => validateReferenceInteractions(bundle, { fragments: false })]) {
    try { validate(); }
    catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== "GENERATION_INCOMPLETE" || !["navigation.fragments", "interaction.controls"].includes(String(error.metadata?.validationCheck))) throw error;
      findings.push({ check: String(error.metadata?.validationCheck), message: error.message });
    }
  }
  return findings;
}

/** Upload usage is content coverage. Invalid asset references/security still
 * fail in their separate unchanged validators. Edits keep strict upload usage. */
export async function generationAssetAdvisories(execution: Pick<ExecutionProvider, "listFiles" | "readFile">, environmentId: string, manifest?: AssetManifest): Promise<readonly { readonly check: string; readonly message: string }[]> {
  try { await validateRequiredUserAssetReferences(execution, environmentId, manifest); return []; }
  catch (error) {
    if (!(error instanceof ApplicationError) || error.code !== "USER_ASSET_NOT_REFERENCED") throw error;
    return [{ check: "user-assets.coverage", message: error.message }];
  }
}
