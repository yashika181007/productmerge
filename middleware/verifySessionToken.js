require('@shopify/shopify-api/adapters/node');
const { shopifyApi } = require('@shopify/shopify-api');

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION;
const shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES.split(','),
    hostName: process.env.URL.replace(/^https?:\/\//, ''),
    isEmbeddedApp: true,
    apiVersion: SHOPIFY_API_VERSION,
});

module.exports = async function verifySessionToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace('Bearer ', '').trim();
        if (!token) {
            console.warn('[Middleware] Missing session token');
            throw new Error('Missing session token');
        }
        console.log('[Middleware] Session token received');

        const jwtPayload = await shopify.api.session.decodeSessionToken(token);
        console.log('[Middleware] Decoded JWT payload:', jwtPayload);

        if (!jwtPayload.dest) {
            console.warn('[Middleware] JWT payload missing dest');
            throw new Error('Invalid session token payload');
        }
        const destUrl = new URL(jwtPayload.dest);
        const shopDomain = destUrl.hostname;
        req.shop = shopDomain;
        console.log(`[Middleware] Session valid for shop: ${shopDomain}`);

        if (jwtPayload.sub) {
            const userId = jwtPayload.sub;
            const sessionId = await shopify.api.session.getJwtSessionId(shopDomain, userId);
            const session = await sessionStorage.loadSession(sessionId);
            if (!session) {
                console.warn('[Middleware] No stored session for JWT session ID:', sessionId);
                throw new Error('Session not found');
            }
            req.session = session;
            console.log('[Middleware] Loaded Shopify session from storage');
        }

        return next();
    } catch (error) {
        console.error('[Middleware] Session verification failed:', error);
        return res.status(401).send('Unauthorized - Invalid session token');
    }
};
