'use strict';
const test=require('node:test'),c=require('./common.cjs'),stage=require('./stage.cjs');const{fs,path,assert}=c;
const owned=path.resolve(__dirname,'../../release-preparation/20261025/packaging');fs.mkdirSync(owned,{recursive:true});
function fixture(run){const root=fs.mkdtempSync(path.join(owned,'test-'));try{for(const file of ['package.json','yarn.lock','workspace.json','nx.json','LICENSE.md','README.md','CONTRIBUTION.md'])fs.writeFileSync(path.join(root,file),file.endsWith('.json')?'{}':'fixture');return run(root);}finally{assert(c.inside(owned,root));fs.rmSync(root,{recursive:true});}}
function put(root,file,value='fixture'){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);return target;}
function plan(root){const source=c.sourceFiles(root).map(file=>c.row(root,file)),licenses=path.join(root,'approved-notices');put(licenses,'NOTICE.txt');return{version:1,workspace:root,publicationReady:false,publicationHolds:c.HOLDS,findings:[],source,sourceDigest:c.sha(JSON.stringify(source)),licenses:{root:licenses,files:[c.row(licenses,path.join(licenses,'NOTICE.txt'))]},nativeContinuity:{selfContained:false}};}
test('allowlist retains exact public docs/native restore config and rejects private/runtime outputs',()=>fixture(root=>{
 for(const name of ['PREVIEW-NOTES.md','KNOWN-LIMITATIONS.md','BUG-REPORTING.md','DATA-AND-BACKUP.md'])put(root,name);
 put(root,'engine/NuGet.Config');put(root,'apps/desktop/main/src/example.ts');put(root,'docs/miss-analysis-policy.md','synthetic private QA policy; live original must remain unstaged');
 for(const name of ['.env','apps/desktop/.env.local','apps/desktop/profile/state.json','apps/desktop/private.osr','apps/desktop/PRODUCT.md','apps/desktop/DESIGN.md','engine/RewindPerformance/bin/old.dll','qa/evidence.json'])put(root,name,'synthetic excluded fixture');
 const names=c.sourceFiles(root).map(file=>c.normal(path.relative(root,file)));
 for(const name of ['PREVIEW-NOTES.md','KNOWN-LIMITATIONS.md','BUG-REPORTING.md','DATA-AND-BACKUP.md','engine/NuGet.Config','apps/desktop/main/src/example.ts'])assert(names.includes(name));
 assert(!names.some(name=>/\.env|private\.osr|old\.dll|evidence|state\.json|(?:PRODUCT|DESIGN)\.md/.test(name)));
 assert(!names.includes('docs/miss-analysis-policy.md'));assert(fs.existsSync(path.join(root,'docs/miss-analysis-policy.md')));
}));
test('fresh/path guards reject live, parent, sibling-prefix and existing outputs',()=>fixture(root=>{
 assert.throws(()=>c.fresh(root,path.join(root,'dist/new')),/outside/);
 assert.throws(()=>c.contained(root,root),/outside/);assert.throws(()=>c.contained(root,root+'-other/file'),/outside/);
 const output=path.join(root,'release-preparation/new');fs.mkdirSync(output,{recursive:true});assert.throws(()=>c.fresh(root,output),/Fresh/);
}));
test('native SQLite libraries and notices remain allowed while database payloads and sidecars are denied',()=>{
 for(const file of ['Microsoft.Data.Sqlite.dll','licenses/Microsoft.Data.Sqlite.Core-10.0.9-UPSTREAM-LICENSE.TXT','licenses/SourceGear.sqlite3-3.50.4.5-LICENSE.txt'])assert.equal(c.denied(file,false),false,file);
 for(const file of ['library.db','library.sqlite','library.sqlite3','library.realm','library.db-wal','library.sqlite-shm','library.sqlite3-journal','library.realm.lock','library.realm.management','library.realm.management/access_control','private.osr','private.osr.backup','secret.key.backup'])assert.equal(c.denied(file,false),true,file);
});
test('reparse-class inputs fail before copying (modeled lstat; no junction created)',()=>fixture(root=>{
 const target=put(root,'source.txt'),original=fs.lstatSync;try{fs.lstatSync=file=>file===target?{isSymbolicLink:()=>true}:original(file);assert.throws(()=>c.ordinary(root,target),/Reparse/);}finally{fs.lstatSync=original;}
}));
test('redacted scanner detects private keys, workspace paths and tokens without emitting values',()=>fixture(root=>{
 const secret=['-----BEGIN',' PRIVATE KEY-----'].join(''),token=['gh','p_','A'.repeat(30)].join('');const file=put(root,'example.ts',[secret,token,root].join('\n'));const found=c.findings(root,[file]);assert.equal(found.length,3);const serialized=JSON.stringify(found);assert(!serialized.includes(secret)&&!serialized.includes(token)&&!serialized.includes(root));assert(found.every(item=>item.matchContentsRedacted));
}));
test('child environment removes preloads, publishing/signing credentials and injected NX values',()=>{
 const environment=c.sanitizeEnvironment({PATH:'tools',SystemRoot:'system',NODE_OPTIONS:'preload-fixture',GH_TOKEN:'synthetic',CSC_LINK:'synthetic',NX_CLOUD_ACCESS_TOKEN:'synthetic',NX_PUBLIC_VALUE:'synthetic'},'owned-absent-env');
 assert.equal(environment.PATH,'tools');assert.equal(environment.SystemRoot,'system');for(const key of ['NODE_OPTIONS','GH_TOKEN','CSC_LINK','NX_CLOUD_ACCESS_TOKEN','NX_PUBLIC_VALUE'])assert(!Object.hasOwn(environment,key));assert.equal(environment.DOTENV_CONFIG_PATH,'owned-absent-env');assert.equal(environment.NODE_ENV,'production');
});
test('source staging copies only pinned allowlist and supplemental licenses; overwrite/tamper fail',()=>fixture(root=>{
 put(root,'apps/desktop/main/src/example.ts');put(root,'.env','synthetic excluded');const selected=plan(root),file=put(root,'release-preparation/plan.json',JSON.stringify(selected)),out=path.join(root,'release-preparation/source');
 const result=stage.sourceStage(root,file,out);assert.equal(result.publicationReady,false);assert(fs.existsSync(path.join(out,'apps/desktop/main/src/example.ts')));assert(fs.existsSync(path.join(out,'THIRD-PARTY-LICENSES/NOTICE.txt')));assert(!fs.existsSync(path.join(out,'.env')));const publicManifest=path.join(out,'SOURCE-MANIFEST.json');assert(!fs.readFileSync(publicManifest,'utf8').includes(root));assert.equal(c.findings(root,[publicManifest]).length,0);assert.throws(()=>stage.sourceStage(root,file,out),/Fresh/);
 put(root,'apps/desktop/main/src/example.ts','changed');assert.throws(()=>c.loadPlan(root,file),/changed/);
}));
test('source inventory additions and traversal manifest entries fail closed',()=>fixture(root=>{
 const selected=plan(root),file=put(root,'release-preparation/plan.json',JSON.stringify(selected));put(root,'apps/new.ts');assert.throws(()=>c.loadPlan(root,file),/inventory changed/);assert.throws(()=>c.verifyRows(root,[{file:'../outside',bytes:1,sha256:'0'}]),/outside/);
}));
test('framework-dependent native receipt prevents app staging before any output copy',()=>fixture(root=>{
 const selected=plan(root),file=put(root,'release-preparation/plan.json',JSON.stringify(selected)),output=path.join(root,'release-preparation/app');assert.throws(()=>stage.appStage(root,file,path.join(root,'never-read.json'),output),/framework-dependent/);assert(!fs.existsSync(output));
}));
test('app and project metadata retain reviewed description without invented author/repository',()=>{
 const description='Replay viewer and library for osu!standard.';const metadata=stage.appMetadata({name:'hindsight',productName:'Hindsight',version:'0.1.0-preview.1',description,license:'MIT',author:'unreviewed',repository:'unreviewed'},[{name:'lzma',version:'2.3.2'}]);assert.equal(metadata.description,description);assert.equal(metadata.main,'index.js');assert(!Object.hasOwn(metadata,'author')&&!Object.hasOwn(metadata,'repository'));assert.deepEqual(metadata.dependencies,{lzma:'2.3.2'});
});
test('installed runtime closure resolves all actual external packages and locked transitive packages without copies',()=>{
 const root=path.resolve(__dirname,'../..'),packages=stage.runtimeClosure(root),names=new Set(packages.map(item=>item.name));for(const name of ['electron-log','lzma','node-osr','tslib','int64-buffer','leb'])assert(names.has(name));assert(packages.every(item=>item.files.some(file=>file.file==='package.json')));
});
