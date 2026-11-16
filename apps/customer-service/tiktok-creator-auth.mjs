import { isPlatformId } from './tiktok-shop-read.mjs';

const affiliateCreator = 'TIKTOK_SHOP_CREATOR';
const creatorTypes = new Set(['TIKTOK_SHOP_OFFICIAL_ACCOUNT', 'TIKTOK_MARKETING_ACCOUNT', affiliateCreator]);
const postingScope = 'creator.video.write';

export class CreatorTrialError extends Error {}

export function creatorAuthorizationUrl(appKey, state) {
  const url = new URL('https://shop.tiktok.com/alliance/creator/auth');
  url.search = new URLSearchParams({ app_key: appKey, state }).toString();
  return url;
}

export function validCreatorTrial({ account, productId }) {
  return typeof account === 'string' && account !== '..' && /^[a-z0-9_.]{2,24}$/u.test(account) && isPlatformId(productId);
}

export async function verifyCreatorIdentity({ tokens, client, account, productId }) {
  if (!validCreatorTrial({ account, productId }) || tokens?.user_type !== 1 || typeof tokens.access_token !== 'string' ||
      !tokens.access_token || !Array.isArray(tokens.granted_scopes) || !tokens.granted_scopes.includes(postingScope)) {
    throw new CreatorTrialError('达人账号未返回挂车发布权限。');
  }
  const profile = await client.creatorProfile(tokens.access_token);
  if (typeof profile?.username !== 'string' || profile.username.toLowerCase() !== account || profile.selection_region !== 'MY' ||
      !creatorTypes.has(profile.user_type) || typeof profile.creator_user_open_id !== 'string' || !profile.creator_user_open_id) {
    throw new CreatorTrialError('平台返回的达人账号、市场或账号类型与原发布任务不符。');
  }
  return profile.user_type;
}

export async function verifyCreatorTrial({ tokens, client, account, productId }) {
  const accountType = await verifyCreatorIdentity({ tokens, client, account, productId });
  const showcase = accountType === affiliateCreator;
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 200; page++) {
    const products = await (showcase ? client.creatorShowcaseProducts(tokens.access_token, cursor) :
      client.creatorShopProducts(tokens.access_token, cursor));
    if (!Array.isArray(products?.products)) throw new CreatorTrialError('无法读取原账号可挂车商品。');
    const matched = products.products.filter(product => product?.id === productId);
    if (matched.length > 0) {
      const status = matched[0].status;
      const eligible = showcase ? status?.added_status === 'ADDED' && status.inventory_status === 'IN_STOCK' &&
        status.review_status === 'APPROVED' && status.is_hidden === false : matched[0].added_status === 'ADDED';
      if (matched.length !== 1 || !eligible) throw new CreatorTrialError('原商品在该账号下未返回可挂车状态。');
      return { account, productId, market: 'MY', accountType };
    }
    cursor = products.next_page_token;
    if (!cursor) break;
    if (typeof cursor !== 'string' || cursors.has(cursor)) throw new CreatorTrialError('达人商品分页异常。');
    cursors.add(cursor);
  }
  throw new CreatorTrialError('在该账号可挂车商品中未核到原商品。');
}
