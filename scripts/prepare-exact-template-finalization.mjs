// Offline preparation only. Existing publisher dry-run; every shared write port throws.
import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import {copyFile,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {TemplatePublisher} from '../dist/templates/publishing/template-publisher.js';
import {TrustedInternalTemplateBuildRunner} from '../dist/templates/publishing/template-build.js';
import {PlaywrightTemplateBrowserQA} from '../dist/templates/publishing/template-browser-qa.js';
import {loadTemplateManifest} from '../dist/templates/publishing/template-manifest.js';
import {packageTemplateSource} from '../dist/templates/publishing/template-package.js';
import {validateTemplateSource} from '../dist/templates/publishing/template-source.js';

const repaired=['creative-agency','real-estate','healthcare-clinic'];
const original=resolve(process.argv[2]??'.sites-runtime/exact-template-fixtures/published-mzzhUP');
const reference=resolve(process.argv[3]??'.sites-runtime/exact-template-finalization-reference');
const baseline=JSON.parse(await readFile(join(original,'catalog.json'),'utf8'));
const inspection=JSON.parse(await readFile(join(reference,'catalog-check.json'),'utf8'));
const parent=resolve('.sites-runtime/exact-template-finalization');await mkdir(parent,{recursive:true});
const root=await mkdtemp(join(parent,'prepared-'));await mkdir(join(root,'proof'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const deny=async()=>{throw new Error('OFFLINE_PREPARATION_SHARED_ACCESS_FORBIDDEN');};
const catalog=[];const plan=[];
process.env.npm_config_offline='true';

async function compareImages(first,second){
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  return await page.evaluate(async({a,b})=>{
   const pixels=async s=>{const image=new globalThis.Image();image.src='data:image/webp;base64,'+s;await image.decode();const canvas=globalThis.document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return{width:image.width,height:image.height,data:ctx.getImageData(0,0,image.width,image.height).data};};
   const x=await pixels(a),y=await pixels(b);if(x.width!==y.width||x.height!==y.height)return{mean:255,changed:1};
   let sum=0,changed=0;for(let i=0;i<x.data.length;i+=4){let max=0;for(let c=0;c<3;c++){const d=Math.abs(x.data[i+c]-y.data[i+c]);sum+=d;max=Math.max(max,d);}if(max>24)changed++;}
   return{mean:sum/(x.width*x.height*3),changed:changed/(x.width*x.height)};
  },{a:Buffer.from(first).toString('base64'),b:Buffer.from(second).toString('base64')});
 }finally{await browser.close();}
}

for(const old of baseline){
 const latest=inspection.active.find(r=>r.templateKey===old.templateKey);
 if(!latest||latest.version!==old.version||latest.sourceSha256!==old.sourceSha256)throw new Error('PUBLISHED_BASELINE_CHANGED');
 if(!repaired.includes(old.templateKey)){
  const bytes=await readFile(join(original,old.templateKey+'.zip'));if(digest(bytes)!==old.sourceSha256)throw new Error('BASELINE_SHA_MISMATCH');
  await copyFile(join(original,old.templateKey+'.zip'),join(root,old.templateKey+'.zip'));catalog.push(old);continue;
 }
 const key=old.templateKey,directory=resolve('templates',key),manifest=await loadTemplateManifest(directory);
 if(manifest.templateKey!==key||manifest.version!==2||manifest.name!==old.name||JSON.stringify(manifest.routes)!==JSON.stringify(old.routes)||JSON.stringify(manifest.tags)!==JSON.stringify(old.tags))throw new Error('TEMPLATE_IDENTITY_CHANGED');
 const category=inspection.categories.find(c=>c.id===old.categoryId&&c.categoryKey===manifest.categoryKey);if(!category)throw new Error('CATEGORY_IDENTITY_CHANGED');
 const out=join(root,key);await mkdir(out);
 const archive=await packageTemplateSource(await validateTemplateSource(directory));
 const qa=new PlaywrightTemplateBrowserQA();
 const captured={async run(input){const result=await qa.run(input);await writeFile(join(out,'publication-qa.json'),JSON.stringify(result.report));for(const [name,preview]of Object.entries(result.previews))await copyFile(preview.path,join(out,name+'.webp'));return result;}};
 const publisher=new TemplatePublisher({findTemplateVersion:deny,createTemplateVersion:deny},{async findCategoryByKey(k){if(k!==category.categoryKey)throw new Error('WRONG_CATEGORY');return{...category,name:old.name,description:old.description,sortOrder:0,createdAt:new Date(0),updatedAt:new Date(0)};}},{bucketName:'offline-only',objectExists:deny,putObject:deny,deleteObject:deny},{invalidateTemplateCatalogCache:deny},new TrustedInternalTemplateBuildRunner(),console,captured);
 const result=await publisher.publish({directory,dryRun:true});if(result.sha256!==archive.sha256)throw new Error('SOURCE_CHANGED_DURING_PREPARATION');
 await writeFile(join(out,'template.zip'),archive.bytes);await writeFile(join(root,key+'.zip'),archive.bytes);
 const previews={};
 for(const viewport of ['desktop','tablet','mobile']){
  const bytes=await readFile(join(out,viewport+'.webp'));const comparison=await compareImages(await readFile(join(reference,`${key}-${viewport}.webp`)),bytes);
  if(comparison.mean>1.5||comparison.changed>0.02)throw new Error(`VISUAL_REGRESSION_${key}_${viewport}: ${JSON.stringify(comparison)}`);
  previews[viewport]={object:result.objects.previews[viewport],sha256:digest(bytes),sizeBytes:bytes.length,comparison};
 }
 const prepared={...old,version:2,id:`${key}:2`,sourceObject:result.objects.source,sourceSha256:archive.sha256,previews:result.objects.previews,status:'active'};catalog.push(prepared);
 plan.push({templateKey:key,version:2,categoryKey:manifest.categoryKey,categoryId:old.categoryId,source:{object:result.objects.source,sha256:archive.sha256,sizeBytes:archive.sizeBytes},previews,publicationQA:'PASS',routes:result.routesChecked,viewports:result.viewportsChecked});
 await writeFile(join(out,'preparation.json'),JSON.stringify(result,null,2));console.info(JSON.stringify(plan.at(-1)));
}
for(const name of ['desktop','tablet','mobile'])await copyFile(join(original,`ecommerce-${name}.webp`),join(root,`ecommerce-${name}.webp`));
await writeFile(join(root,'catalog.json'),JSON.stringify(catalog));
await writeFile(join(root,'publication-plan.json'),JSON.stringify({preparedAt:new Date().toISOString(),approval:'PENDING',gcsPublication:'NOT_STARTED',catalogActivation:'NOT_STARTED',templates:plan},null,2));
console.info(JSON.stringify({fixtureRoot:root,templates:catalog.map(r=>({key:r.templateKey,version:r.version})),providerCalls:0,mongoWrites:0,gcsWrites:0}));
