import {SellerCenterPageChannel} from './seller-center-page.mjs';
import {fail} from '../lib/common.mjs';
export {SellerCenterPageChannel};
export function createChannel(name,options){
 if(name==='seller-center-page')return new SellerCenterPageChannel(options);
 if(name==='tiktok-shop-api')fail('tiktok_shop_api_channel_not_implemented',40);
 fail('unknown_publishing_channel',40,{name});
}
