import {zaloImageReference} from './image-reader.js';
import {normalizeZaloContent} from './zalo-content.js';
export type RelayMedia={kind:'image'|'file';name:string;bytes?:number;url?:string;fileId?:string;mime?:string};
export type RelayPayload={sender:string;sourceName:string;text:string;media?:RelayMedia};
export type RelayEnvelope={platform:'zalo'|'telegram';accountId:string;chatId:string;messageId:string;at:Date;payload:RelayPayload};
const object=(v:any):any=>{if(v&&typeof v==='object')return v;try{return JSON.parse(v);}catch{return{};}};
const clean=(v:any,max=16000)=>String(v||'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,' ').slice(0,max);
export function zaloRelayPayload(data:any):RelayPayload|null{
 const c=object(data?.content),p=object(c.params),image=zaloImageReference(data),kind=String(data?.msgType||'').toLowerCase();
 let text='',media:RelayMedia|undefined;
 if(image){const name=String(c.fileName||c.title||'');media={kind:'image',url:image.url,name:/\.(png|jpe?g|webp|gif)$/i.test(name)?name:'image.jpg',bytes:Number(c.totalSize||p.totalSize||0)||undefined};text=clean(p.desc||c.description);}
 else if(['share.file','chat.file'].includes(kind)){
  const url=[c.href,c.fileUrl,c.url,p.fileUrl,p.rawUrl,p.url].find(v=>typeof v==='string'&&/^https?:\/\//i.test(v));
  if(!url)return null;media={kind:'file',url,name:clean(c.title||c.fileName||p.fileName||'attachment.bin',160),bytes:Number(c.totalSize||p.totalSize||p.fileSize||0)||undefined};text=clean(c.description);
 }else{const normalized=normalizeZaloContent(data);if(['text','richtext'].includes(normalized.kind))text=normalized.text;else if(normalized.kind==='shared'){text=[c.title,c.href,c.url,c.description].filter(v=>typeof v==='string'&&v.trim()).join('\n');}else return null;}
 if(!text&&!media)return null;return{sender:clean(data?.dName||data?.uidFrom,100),sourceName:'',text:clean(text),...(media?{media}:{})};
}
export function telegramRelayEnvelope(message:any,botId:string):RelayEnvelope|null{
 if(!['group','supergroup'].includes(message?.chat?.type)||!message.from||message.from.is_bot||message.sender_chat||!message.message_id)return null;
 if(/^\/(?:bridge|start)(?:@\w+)?(?:\s|$)/i.test(message.text||''))return null;
 let media:RelayMedia|undefined;
 if(Array.isArray(message.photo)&&message.photo.length){const photo=message.photo.at(-1);media={kind:'image',name:'photo.jpg',fileId:photo.file_id,bytes:photo.file_size,mime:'image/jpeg'};}
 else if(message.document){const d=message.document;media={kind:'file',name:d.file_name||'attachment.bin',fileId:d.file_id,bytes:d.file_size,mime:d.mime_type};}
 else if(!message.text)return null;
 const text=clean(message.text||message.caption||'');if(!text&&!media)return null;
 return{platform:'telegram',accountId:botId,chatId:String(message.chat.id),messageId:String(message.message_id),at:new Date(Number(message.date)*1000),payload:{sender:clean([message.from.first_name,message.from.last_name].filter(Boolean).join(' ')||message.from.username||message.from.id,100),sourceName:clean(message.chat.title,100),text,...(media?{media}:{})}};
}
export function relayTextChunks(value:string,limit=2000){const chunks:string[]=[];let part='';for(const char of value){if(part.length+char.length>limit){chunks.push(part);part='';}part+=char;}if(part)chunks.push(part);return chunks;}
