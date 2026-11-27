'use strict';
const {fs,path,assert,ordinary}=require('./common.cjs');
const {NtExecutable,NtExecutableResource,Resource}=require('resedit');

function clearCompanyName(bytes){
  // Default parsing rejects signed binaries. This hook belongs before signing.
  const executable=NtExecutable.from(bytes),resources=NtExecutableResource.from(executable);
  const versions=Resource.VersionInfo.fromEntries(resources.entries);
  assert(versions.length>0,'Windows version resources required');
  for(const version of versions){
    const languages=version.getAllLanguagesForStringValues();
    assert(languages.length>0,'Windows version string tables required');
    for(const language of languages)version.setStringValue(language,'CompanyName','');
    version.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(executable);
  return Buffer.from(executable.generate());
}

async function afterPack(context){
  if(context.electronPlatformName!=='win32')return;
  // A future owner-provided author supplies CompanyName in the builtin editor.
  if(context.packager.appInfo.companyName!=null)return;
  const directory=path.resolve(context.appOutDir),name=context.packager.appInfo.productFilename;
  assert(typeof name==='string'&&name.length>0&&path.basename(name)===name&&!/[\\/]/.test(name),'Expected packaged executable basename');
  const file=path.join(directory,name+'.exe');ordinary(directory,file);
  assert(fs.lstatSync(file).isFile(),'Packaged executable must be a regular file');
  const bytes=await fs.promises.readFile(file);
  await fs.promises.writeFile(file,clearCompanyName(bytes));
}

module.exports=afterPack;
module.exports.clearCompanyName=clearCompanyName;
