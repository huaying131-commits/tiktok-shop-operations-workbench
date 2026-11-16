import {OfficialDriver} from '../lib/browser-driver.mjs';
import {fail} from '../lib/common.mjs';
import {verifyProductLinkFinalReadback} from '../../../operations/video-publishing/product-link-final-readback.mjs';
// The page-specific implementation stays behind this boundary. No transport is started by construction.
export class SellerCenterPageChannel{
 constructor({driver,...options}){this.name='seller-center-page';this.driver=driver??new OfficialDriver(options);}
 get root(){return this.driver.root;}
 get lastRequest(){return this.driver.protocol?.lastRequest??this.driver.lastRequest;}
 read(op,data){return this.driver.call('read',op,data);}
 uploadStep(op,data){return this.driver.call('write',op,data);}
 selectAccount(data){return this.driver.call('write','select_account',data);}
 attachProduct(data){return this.driver.call('write','attach_product',data);}
 fillField(op,data){return this.driver.call('write',op,data);}
 submitOnce(data){return this.driver.call('write','submit',data);}
 write(op,data){
  if(['buffer','transfer','assign'].includes(op))return this.uploadStep(op,data);
  if(op==='select_account')return this.selectAccount(data);
  if(op==='attach_product')return this.attachProduct(data);
  if(op.startsWith('fill_'))return this.fillField(op,data);
  if(op==='submit')return this.submitOnce(data);
  return this.driver.call('write',op,data);
 }
 call(kind,op,data){return kind==='read'?this.read(op,data):this.write(op,data);}
 verifyFinalReadback(input){return verifyProductLinkFinalReadback(input);}
 verifyIdentity(p){
  if(p?.login||p?.captcha)fail(p.login?'login_required':'captcha_required',30);
  let u;try{u=new URL(p.url);}catch{fail('owned_page_identity_unverified');}
  if(!p.owner||!p.target_id||u.origin!=='https://seller.tiktokshopglobalselling.com'||u.searchParams.getAll('shop_region').length!==1||u.searchParams.get('shop_region')!=='MY'||!p.shop?.includes('Malaysia')||!p.shop.includes('(example-shop-my)'))fail('owned_page_identity_unverified');
  return true;
 }
}
