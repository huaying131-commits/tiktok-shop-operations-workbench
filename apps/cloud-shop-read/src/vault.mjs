import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdir,readFile,rename,open,chmod,unlink,lstat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
export function createVault({file,key}){
 if(!Buffer.isBuffer(key)||key.length!==32)throw new Error('External 32-byte encryption key required');
 file=resolve(file);
 return {
  async load(){
   const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1048576||(process.platform!=='win32'&&(info.mode&0o077)))throw new Error('Private encrypted file required');
   const doc=JSON.parse(await readFile(file,'utf8'));if(doc.version!==1)throw new Error('Unsupported vault version');
   const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(doc.iv,'base64'));decipher.setAAD(Buffer.from('huaying-shop-read-v1'));decipher.setAuthTag(Buffer.from(doc.tag,'base64'));
   return JSON.parse(Buffer.concat([decipher.update(Buffer.from(doc.data,'base64')),decipher.final()]).toString('utf8'));
  },
  async save(value){
   if(!value?.serviceId||!value.appKey||!value.appSecret||!value.tokens?.access_token||value.tokens.user_type!==0)throw new Error('Complete seller authorization required');
   const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('huaying-shop-read-v1'));
   const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
   await mkdir(dirname(file),{recursive:true,mode:0o700});
   const pending=file+'.'+randomBytes(8).toString('hex')+'.tmp';
   try{
    const output=await open(pending,'wx',0o600);
    try{await output.writeFile(JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));await output.sync();}finally{await output.close();}
    await rename(pending,file);
    if(process.platform!=='win32'){
     await chmod(file,0o600);
     const directory=await open(dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
    }
   }finally{await unlink(pending).catch(()=>{});}
  }
 };
}
