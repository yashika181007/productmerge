const jwt = require('jsonwebtoken');
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

module.exports = async function verifySessionToken(req, res, next) {
  const token = req.query.token;

  if (!token) {
    return res.status(401).send("Missing session token");
  }

  try {
    const payload = jwt.verify(token, SHOPIFY_API_SECRET, {
      algorithms: ['HS256']
    });

    req.sessionTokenPayload = payload;
    next();
  } catch (err) {
    console.error('Session token validation error:', err);
    return res.status(401).send("Invalid session token");
  }
};
