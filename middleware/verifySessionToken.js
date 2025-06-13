require('@shopify/shopify-api/adapters/node');
const { shopifyApi } = require('@shopify/shopify-api');

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';
const shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES.split(','),
    hostName: process.env.URL.replace(/^https?:\/\//, ''),
    isEmbeddedApp: true,
    apiVersion: SHOPIFY_API_VERSION,
});

module.exports = async function verifySessionToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) {
        return res.status(401).send('Unauthorized');
    }
    let jwtPayload;
    try {
        jwtPayload = await shopify.session.decodeSessionToken(token);
    } catch {
        return res.status(401).send('Unauthorized');
    }
    if (!jwtPayload.dest) {
        return res.status(401).send('Unauthorized');
    }
    const shopDomain = new URL(jwtPayload.dest).hostname;
    req.shop = shopDomain;
    next();
};
