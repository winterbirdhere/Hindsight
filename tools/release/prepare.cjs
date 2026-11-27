'use strict';
const c=require('./common.cjs');const{fs,path,assert}=c;
// The free Windows preview retains this exact Garin/Rewind selection and credited ppy assets.
// Different skin payloads still need their own release review.
function previewHolds(skins) {
  const readmes = new Set(['resources/Skins/RewindDefaultSkin/README.md', 'resources/Skins/OsuDefaultSkin/README.md']);
  const assets = skins.filter(row => !readmes.has(row.file)).map(row => [row.file, row.sha256]);
  assets.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (c.sha(JSON.stringify(assets)) !== '49650b019662d230eb350a3759ab187b274de9355c3f19a85c9d773e3f250346') return c.HOLDS;
  return c.HOLDS.filter(hold => hold !== 'Bundled skin redistribution evidence remains unresolved');
}

function prepare(root,evidence,licenses,output){root=c.workspace(root);output=c.fresh(root,output);assert(c.inside(root,licenses),'Explicit local license input required');c.ordinary(root,licenses);const licenseFiles=c.walk(licenses,licenses,{source:false});assert(licenseFiles.length>0&&licenseFiles.every(file=>/\.(?:md|txt|json|html)$/i.test(file)),'Reviewed textual license supplement required');const files=c.sourceFiles(root),issues=[...c.findings(root,files),...c.findings(root,licenseFiles).map(row=>({...row,file:'THIRD-PARTY-LICENSES/'+path.basename(row.file)}))];const metadata=c.json(path.join(root,'package.json'));assert.equal(metadata.name,'hindsight');assert.equal(metadata.productName,'Hindsight');assert.equal(metadata.version,'0.1.0');
 const workflow=path.join(root,'.github/workflows/build-release.yml');if(fs.existsSync(workflow)){const text=fs.readFileSync(workflow,'utf8');assert(!/^\s*(?:push|pull_request_target)\s*:/m.test(text)&&!/(?:GH_TOKEN|secrets\.|--publish\s+\$(?:env:)?)/.test(text)&&/--publish never/.test(text),'CI publication safety requires review');}
 const native=c.nativeContinuity(root,evidence);
 const resources={media:require('../media/verify-runtime.cjs').verifyMedia(root,true).rows,skins:c.walk(root,path.join(root,'resources/Skins'),{source:false}).map(file=>c.row(root,file))};
 const plan={version:1,workspace:root,createdUtc:new Date().toISOString(),publicationReady:false,publicationHolds:previewHolds(resources.skins),findings:issues,source:files.map(file=>c.row(root,file)),licenses:{root:licenses,files:licenseFiles.map(file=>c.row(licenses,file))},nativeContinuity:native,candidateNativeHold:!native.selfContained,resources,metadata:{name:metadata.name,productName:metadata.productName,version:metadata.version,description:metadata.description,license:metadata.license},operationsPerformed:{copiedSource:false,compiled:false,packaged:false,published:false}};
 plan.sourceDigest=c.sha(JSON.stringify(plan.source));fs.mkdirSync(output,{recursive:true});c.write(path.join(output,'plan.json'),plan);console.log(JSON.stringify({ok:issues.length===0,plan:path.join(output,'plan.json'),sourceFiles:plan.source.length,redactedFindings:issues.length,publicationReady:false,candidateNativeHold:plan.candidateNativeHold}));if(issues.length)process.exitCode=1;return plan;
}
module.exports={prepare,previewHolds};if(require.main===module){try{const a=c.args(process.argv.slice(2),['--workspace','--native-evidence','--licenses','--output']);prepare(a['--workspace'],a['--native-evidence'],a['--licenses'],a['--output']);}catch(error){console.error(error.message);process.exitCode=1;}}
