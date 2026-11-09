import {Agent,fetch as mediaFetch,type Dispatcher} from 'undici';
import {lookup} from 'node:dns/promises';
import {publicAddress} from './knowledge.js';
export const RELAY_MAX_BYTES=20*1024*1024;
export function safeRelayFilename(raw:string,fallback='attachment.bin'){
 const value=String(raw||'').split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f<>:"|?*]/g,'_').trim();if(!value||value==='.'||value==='..')return fallback;const ext=value.match(/(\.[a-zA-Z0-9]{1,12})$/)?.[1]||'';const stem=ext?value.slice(0,-ext.length):value;let prefix='';for(const char of stem){if(Buffer.byteLength(prefix+char+ext)>200)break;prefix+=char;}return prefix+ext||fallback;
}
type RelayDownloadOptions={lookupHost?:(host:string)=>Promise<{address:string;family:number}[]>;dispatcher?:Dispatcher};
export async function downloadRelayFile(raw:string,lockedOrigin?:string,options:RelayDownloadOptions={}){
 let url:URL;try{url=new URL(raw);}catch{throw new Error('Link tải file không hợp lệ.');}
 const signal=AbortSignal.timeout(30000);
 for(let hop=0;hop<4;hop++){
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port))||(lockedOrigin&&url.origin!==lockedOrigin))throw new Error('Nguồn tải file không được phép.');
  const host=url.hostname.replace(/^\[|\]$/g,'');const addresses=await (options.lookupHost?options.lookupHost(host):lookup(host,{all:true})).catch(()=>[]);
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('Không tải file từ địa chỉ nội bộ hoặc metadata.');
  const agent=options.dispatcher||new Agent({connect:{lookup:((_host:any,options:any,cb:any)=>options.all?cb(null,addresses):cb(null,addresses[0].address,addresses[0].family)) as any}});
  try{
   const response=await mediaFetch(url,{dispatcher:agent,redirect:'manual',signal});
   if(response.status>=300&&response.status<400){const next=response.headers.get('location');await response.body?.cancel();if(!next)throw new Error('Chuyển hướng file không hợp lệ.');url=new URL(next,url);continue;}
   if(!response.ok){await response.body?.cancel();throw new Error('Không tải được file công khai (HTTP '+response.status+').');}
   if(Number(response.headers.get('content-length'))>RELAY_MAX_BYTES){await response.body?.cancel();throw new Error('File vượt giới hạn Bridge 20 MB.');}
   const reader=response.body?.getReader();if(!reader)throw new Error('File tải về rỗng.');const parts:Uint8Array[]=[];let total=0;
   try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>RELAY_MAX_BYTES)throw new Error('File vượt giới hạn Bridge 20 MB.');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
   if(!total)throw new Error('File tải về rỗng.');return{data:Buffer.concat(parts),mime:response.headers.get('content-type')||'application/octet-stream'};
  }finally{if(!options.dispatcher)await agent.close();}
 }
 throw new Error('File chuyển hướng quá nhiều lần.');
}
