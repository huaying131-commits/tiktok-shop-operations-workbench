// Fail-closed validator for the JSON Schema keywords used by captured browser requests.
// No dependency install and no vendor execution. Unsupported schema keywords refuse validation.
export function matchesSchema(s,v){
 const known=new Set(['type','properties','required','additionalProperties','anyOf','allOf','oneOf','if','then','else','not','enum','const','minLength','maxLength','minimum','maximum','items','minItems','maxItems','pattern','description','default','title']);
 if(typeof s==='boolean')return s;
 if(!s||typeof s!=='object'||Object.keys(s).some(k=>!known.has(k)))return false;
 const object=v!==null&&typeof v==='object'&&!Array.isArray(v);
 if(s.type){const types=Array.isArray(s.type)?s.type:[s.type];if(!types.some(t=>t==='object'?object:t==='array'?Array.isArray(v):t==='integer'?Number.isInteger(v):t==='number'?typeof v==='number'&&Number.isFinite(v):t==='null'?v===null:typeof v===t))return false;}
 if('const' in s&&JSON.stringify(s.const)!==JSON.stringify(v))return false;
 if(s.enum&&!s.enum.some(x=>JSON.stringify(x)===JSON.stringify(v)))return false;
 if(object){
  if(s.required?.some(k=>!Object.hasOwn(v,k)))return false;
  if(s.additionalProperties===false&&Object.keys(v).some(k=>!Object.hasOwn(s.properties??{},k)))return false;
  for(const [k,sub]of Object.entries(s.properties??{}))if(Object.hasOwn(v,k)&&!matchesSchema(sub,v[k]))return false;
 }
 if(typeof v==='string'&&((s.minLength!==undefined&&[...v].length<s.minLength)||(s.maxLength!==undefined&&[...v].length>s.maxLength)||(s.pattern&&!new RegExp(s.pattern).test(v))))return false;
 if(typeof v==='number'&&((s.minimum!==undefined&&v<s.minimum)||(s.maximum!==undefined&&v>s.maximum)))return false;
 if(Array.isArray(v)&&((s.minItems!==undefined&&v.length<s.minItems)||(s.maxItems!==undefined&&v.length>s.maxItems)||(s.items&&v.some(x=>!matchesSchema(s.items,x)))))return false;
 if(s.allOf&&!s.allOf.every(x=>matchesSchema(x,v)))return false;
 if(s.anyOf&&!s.anyOf.some(x=>matchesSchema(x,v)))return false;
 if(s.oneOf&&s.oneOf.filter(x=>matchesSchema(x,v)).length!==1)return false;
 if(s.not&&matchesSchema(s.not,v))return false;
 if(s.if){const branch=matchesSchema(s.if,v)?s.then:s.else;if(branch&&!matchesSchema(branch,v))return false;}
 return true;
}
export function validateBrowserReadArgs(manifest,args){
 const tool=manifest.tools?.find(t=>t.function?.name==='browser')?.function;
 if(!tool||!matchesSchema(tool.parameters,args))throw Error('PublicBrowserManifestValidationFailed');
 if(args.action==='evaluate'){if(args.params.download!==false)throw Error('DownloadNotPermitted');}
 else if(args.action!=='tabs'||args.params.action!=='list')throw Error('ReadOnlyActionNotPermitted');
 return args;
}
