require('@shopify/shopify-api/adapters/node');
const { shopifyApi } = require('@shopify/shopify-api');

const shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES.split(','),
    hostName: process.env.URL.replace(/^https?:\/\//, ''),
    isEmbeddedApp: true,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-04',
});

module.exports = async function verifySessionToken(req, res, next) {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        console.log('token',token);
        if (!token) throw new Error('Missing session token');

        const session = await shopify.api.session.decodeSessionToken(token);
        console.log(session);
        req.shop = session.shop;
        next();
    } catch (e) {
        console.error('[Middleware] Session verification failed:', e);
        res.status(401).send('Unauthorized - Invalid session token');
    }
};
