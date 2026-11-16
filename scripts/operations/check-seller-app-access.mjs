import { join } from 'node:path';
import { loadLocalAppCredentials, loadLocalAuthorization } from '../../apps/customer-service/tiktok-auth.mjs';
import { createTikTokClient, publicPlatformError } from '../../apps/customer-service/tiktok-shop-read.mjs';

const shopId = '9000000000000000099';
const writeScopes = ['seller.product.write', 'seller.global_product.write', 'seller.promotion.write'];
const permissionPath = '/seller/202309/permissions';
const receipt = {
  checkedAt: new Date().toISOString(),
  shopId,
  endpoint: 'GET ' + permissionPath,
  shopVerified: false,
  shopWritesPerformed: [],
};

// The DPAPI loader spawns Windows PowerShell. Give that child its own module path.
if (process.platform === 'win32' && process.env.SystemRoot) {
  process.env.PSModulePath = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
}

try {
  const credentials = await loadLocalAppCredentials();
  const { tokens } = await loadLocalAuthorization();
  if (tokens?.user_type !== 0 || !tokens.access_token) throw new Error('Seller authorization unavailable');

  receipt.sellerUserType = tokens.user_type;
  receipt.selectedGrantedScopes = Array.isArray(tokens.granted_scopes)
    ? writeScopes.filter(scope => tokens.granted_scopes.includes(scope))
    : null;

  const client = createTikTokClient({
    ...credentials,
    fetchApi: async (url, options) => {
      const response = await fetch(url, options);
      if (url.pathname === permissionPath) {
        const envelope = await response.clone().json().catch(() => null);
        receipt.platform = {
          httpStatus: response.status,
          code: envelope?.code ?? null,
          requestId: envelope?.request_id ?? null,
        };
      }
      return response;
    },
  });

  const shops = await client.authorizedShops(tokens.access_token);
  if (!shops.some(shop => shop.id === shopId && shop.region === 'MY' && shop.name === 'example-shop-my')) {
    throw new Error('Could not verify exact Malaysia shop');
  }
  receipt.shopVerified = true;

  const result = await client.globalProductPermissions(tokens.access_token);
  if (!Array.isArray(result.permissions)) throw new Error('Permissions response incomplete');
  receipt.canManageGlobalProducts = result.permissions.includes('MANAGE_GLOBAL_PRODUCT');
} catch (error) {
  receipt.error = publicPlatformError(error, 'Read failed (' + (error.cause?.code ?? error.name) + ')');
  process.exitCode = 1;
}

console.log(JSON.stringify(receipt, null, 2));
