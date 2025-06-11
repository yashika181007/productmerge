const jwt = require('jsonwebtoken');

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

module.exports = function verifySessionToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).send('Missing session token');
  }

  let decoded;
  try {
    // Verify token using your Shopify API secret
    decoded = jwt.verify(token, SHOPIFY_API_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    console.error('Session token verification failed:', err.message);
    return res.status(401).send('Invalid session token');
  }

  // decoded.dest is like "https://your-shop.myshopify.com"
  if (!decoded.dest) {
    return res.status(401).send('Invalid session token payload');
  }

  // Attach shop domain (without protocol) to req.shop
  req.shop = decoded.dest.replace(/^https?:\/\//, '');
  next();
};
