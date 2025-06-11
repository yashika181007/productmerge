import '@shopify/shopify-api/adapters/node';
require('@shopify/shopify-api/adapters/node'); // 👈 MUST be before using shopifyApi
const { shopifyApi } = require('@shopify/shopify-api');
const shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES.split(','),
    hostName: process.env.URL.replace(/^https?:\/\//, ""),
    isEmbeddedApp: true,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-04',
});

module.exports = async function verifySessionToken(req, res, next) {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
        return res.status(401).send('Missing session token');
    }

    try {
        const payload = await shopify.session.decodeSessionToken(token);
        req.sessionTokenPayload = payload;
        next();
    } catch (err) {
        console.error('Session token validation error:', err.message);
        return res.status(401).send('Invalid session token');
    }
};
