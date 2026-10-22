import { createHash } from 'node:crypto';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const metadata = (template) => JSON.stringify([
  template.templateKey, template.version, template.name, template.description,
  template.categoryId, template.tags, template.status, template.routes,
  template.sourceObject, template.sourceSha256,
  template.previews.desktop, template.previews.tablet, template.previews.mobile,
]);

/** Corporate Business v2 only; delegates all new writes to the existing publisher. */
export async function publishPreparedCorporateBusinessV2({ expected, artifacts, templates, storage, publishNew, finalizeCatalog }) {
  if (expected.templateKey !== 'corporate-business' || expected.version !== 2 || expected.status !== 'active')
    fail('PUBLICATION_SCOPE_VIOLATION', 'Only active Corporate Business v2 is authorized');
  const paths = [
    'sites/templates/corporate-business/v2/source/template.zip',
    'sites/templates/corporate-business/v2/previews/desktop.webp',
    'sites/templates/corporate-business/v2/previews/tablet.webp',
    'sites/templates/corporate-business/v2/previews/mobile.webp',
  ];
  if (artifacts.length !== 4 || paths.some((path) => artifacts.filter((item) => item.object === path).length !== 1))
    fail('PUBLICATION_SCOPE_VIOLATION', 'Exactly the four Corporate Business v2 artifacts are required');
  const verifyArtifacts = async () => {
    const missing = [];
    for (const artifact of artifacts) {
      const existing = await storage.readObject(artifact.object);
      if (!existing) missing.push(artifact.object);
      else if (digest(existing) !== digest(artifact.bytes))
        fail('GCS_ARTIFACT_CONFLICT', `Existing artifact differs: ${artifact.object}`);
    }
    return missing;
  };
  // Check all artifacts before allowing any mutation, even if metadata also differs.
  const missing = await verifyArtifacts();
  const existing = await templates.findTemplateVersion('corporate-business', 2);
  if (existing && metadata(existing) !== metadata(expected))
    fail('TEMPLATE_METADATA_CONFLICT', 'Corporate Business v2 metadata differs from the validated publication');
  if (existing) {
    if (missing.length) fail('PUBLICATION_INCOMPLETE', `Corporate Business v2 is missing artifacts: ${missing.join(', ')}`);
    await finalizeCatalog();
    return { state: 'EXISTING', uploads: 0, mongoCreates: 0, verifiedArtifacts: 4, conflicts: 0 };
  }
  if (missing.length !== 4)
    fail('PUBLICATION_INCOMPLETE', 'Matching v2 artifacts exist without metadata; no overwrite or delete was attempted');
  await publishNew();
  if ((await verifyArtifacts()).length) fail('PUBLICATION_INCOMPLETE', 'Publication did not create all four artifacts');
  const created = await templates.findTemplateVersion('corporate-business', 2);
  if (!created || metadata(created) !== metadata(expected))
    fail('TEMPLATE_METADATA_CONFLICT', 'Created Corporate Business v2 metadata does not match the validated publication');
  await finalizeCatalog();
  return { state: 'CREATED', uploads: 4, mongoCreates: 1, verifiedArtifacts: 4, conflicts: 0 };
}
