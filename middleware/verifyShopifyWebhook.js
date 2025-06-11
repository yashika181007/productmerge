const crypto = require('crypto');

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

module.exports = function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const rawBody = req.rawBody; // ensure bodyParser.raw was used before this

  if (!hmacHeader || !rawBody) {
    return res.status(400).send('Missing webhook HMAC or body');
  }

  const generatedHash = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  if (generatedHash !== hmacHeader) {
    console.warn('❌ Webhook HMAC validation failed.');
    return res.status(401).send('Unauthorized');
  }

  // parse JSON body after validation
  try {
    req.body = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).send('Invalid JSON');
  }

  next();
};
