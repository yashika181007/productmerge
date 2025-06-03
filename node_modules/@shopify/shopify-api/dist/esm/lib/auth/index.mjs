import { callback, begin } from './oauth/oauth.mjs';
import { nonce } from './oauth/nonce.mjs';
import { safeCompare } from './oauth/safe-compare.mjs';
import { buildEmbeddedAppUrl, getEmbeddedAppUrl } from './get-embedded-app-url.mjs';
import { tokenExchange } from './oauth/token-exchange.mjs';
import { clientCredentials } from './oauth/client-credentials.mjs';

function shopifyAuth(config) {
    const shopify = {
        begin: begin(config),
        callback: callback(config),
        nonce,
        safeCompare,
        getEmbeddedAppUrl: getEmbeddedAppUrl(config),
        buildEmbeddedAppUrl: buildEmbeddedAppUrl(config),
        tokenExchange: tokenExchange(config),
        clientCredentials: clientCredentials(config),
    };
    return shopify;
}

export { shopifyAuth };
//# sourceMappingURL=index.mjs.map
