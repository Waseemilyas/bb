import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const req=createRequire(join(root,'package.json'));
const asar=createRequire(createRequire(req.resolve('electron-builder')).resolve('app-builder-lib'))('@electron/asar');
const output=join(root,'release','mac-retry-qa');
await mkdir(output,{recursive:true});
for(const version of ['0.0.1','0.46.0']) {
 const app=join(output,`bb-update-qa-${version}.app`);
 await cp(join(root,'release','mac-arm64','bb.app'),app,{recursive:true});
 const archive=join(app,'Contents','Resources','app.asar');
 const extracted=join(output,`extracted-${version}`);
 asar.extractAll(archive,extracted);
 for(const relative of ['package.json','node_modules/bb-app/package.json']) {
  const file=join(extracted,relative);const info=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...info,version}));
 }
 const mainPath=join(extracted,'dist/main.js');let main=await readFile(mainPath,'utf8');
 const feed='`https://github.com/get-bb/bb/releases/download/${releaseTag}/`';
 if(!main.includes(feed))throw new Error('Missing feed replacement target');
 main=main.replaceAll(feed,'"http://127.0.0.1:24791/"').replaceAll('"0.46.0"',JSON.stringify(version));
 await writeFile(mainPath,main);
 await rm(archive);await rm(`${archive}.unpacked`,{recursive:true,force:true});
 await asar.createPackageWithOptions(extracted,archive,{unpackDir:'node_modules',unpack:'bb-app-bridge.mjs'});
 const plist=join(app,'Contents','Info.plist');
 const info=JSON.parse(execFileSync('plutil',['-convert','json','-o','-',plist],{encoding:'utf8'}));
 info.CFBundleIdentifier='dev.bb.desktop.mac-retry-qa';info.CFBundleName='bb Update QA';info.CFBundleDisplayName='bb Update QA';
 info.CFBundleShortVersionString=version;info.CFBundleVersion=version;
 if(info.ElectronAsarIntegrity?.['Resources/app.asar'])info.ElectronAsarIntegrity['Resources/app.asar'].hash=createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
 await writeFile(plist,JSON.stringify(info));execFileSync('plutil',['-convert','xml1',plist]);
 await writeFile(join(app,'Contents/Resources/app-update.yml'),'provider: generic\nurl: http://127.0.0.1:24791/\nupdaterCacheDirName: bb-mac-retry-qa-updater\n');
 await rm(extracted,{recursive:true,force:true});
}
await writeFile(join(output,'build.json'),JSON.stringify({head:process.env.QA_PRODUCT_HEAD,from:'0.0.1',to:'0.46.0',modifications:['isolated app identity','local release feed','fixture versions only']},null,2));
