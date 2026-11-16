import {day,instant,fail} from './common.mjs';
export function verifyOwnedPageReceipt(page,receipt,at=new Date().toISOString()){
 let u,stamp;try{u=new URL(page.url);stamp=instant(receipt.observed_at);}catch{fail('current_owned_page_receipt_required');}
 if(stamp>instant(at)||day(stamp)!==day(at)||receipt.target_id!==page.target_id||receipt.url!==page.url||receipt.window_name!==page.owner||!page.target_id||!page.owner||u.origin!=='https://seller.tiktokshopglobalselling.com'||u.searchParams.getAll('shop_region').length!==1||u.searchParams.get('shop_region')!=='MY'||!page.shop?.includes('Malaysia')||!page.shop.includes('(example-shop-my)')||!receipt.shop?.includes('Malaysia')||!receipt.shop.includes('(example-shop-my)'))fail('current_owned_page_receipt_required');
 return{verified:true,target_id:page.target_id,url:page.url,window_name:page.owner,market:'MY',observed_at:receipt.observed_at};
}
