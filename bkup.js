require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const qs = require('qs');

const app = express();

// CONFIG
const PORT = process.env.PORT || 3000;
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION;
const NGROK_URL = process.env.NGROK_URL;

// MySQL DB pool
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'productmerge'
});

// -- Raw body parser for webhooks
app.use('/webhook/orders/create', bodyParser.raw({ type: 'application/json' }));

// ------------------------------------------------------------------
// STEP 1: OAuth Install Redirect
// ------------------------------------------------------------------
app.get('/', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.send('Missing shop parameter.');

  const redirectUri = `${NGROK_URL}/callback`;
  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${process.env.SHOPIFY_SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(installUrl);
});

// ------------------------------------------------------------------
// STEP 2: OAuth Callback
//   - validate HMAC
//   - exchange code → access_token
//   - persist to DB
//   - register webhook if not already
// ------------------------------------------------------------------
app.get('/callback', async (req, res) => {
  const { shop, code, hmac } = req.query;
  if (!shop || !code || !hmac) return res.send('Missing parameters.');

  // 1) HMAC validation
  const params = { ...req.query };
  delete params.hmac;
  delete params.signature;
  const message = new URLSearchParams(params).toString();
  const generatedHash = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(message)
    .digest('hex');

  if (
    !crypto.timingSafeEqual(
      Buffer.from(hmac, 'hex'),
      Buffer.from(generatedHash, 'hex')
    )
  ) {
    return res.send('HMAC validation failed.');
  }

  try {
    // 2) Exchange code for permanent access token
    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      qs.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data.access_token;

    // 3) Persist shop + token
    await db.execute(
      `INSERT INTO installed_shops (shop, access_token)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE access_token = ?`,
      [shop, accessToken, accessToken]
    );

    // 4) Fetch existing webhooks
    const existing = await axios.get(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const hasOrderWebhook = existing.data.webhooks.some(wh =>
      wh.topic === 'orders/create' &&
      wh.address === `${NGROK_URL}/webhook/orders/create`
    );

    // 5) Register if missing
    if (!hasOrderWebhook) {
      await axios.post(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
        {
          webhook: {
            topic: 'orders/create',
            address: `${NGROK_URL}/webhook/orders/create`,
            format: 'json'
          }
        },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );
    }

    res.send('App installed & webhook registered.');
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.send('OAuth process failed.');
  }
});

// ------------------------------------------------------------------
// STEP 2.5: Seed Dummy Products
// ------------------------------------------------------------------
app.get('/seed-products', async (req, res) => {
  try {
    const dummy = [
      ['Red T-Shirt', 'A bright red cotton tee', 'https://via.placeholder.com/400.png?text=Red+T-Shirt', 19.99],
      ['Blue Jeans',  'Classic blue denim jeans',    'https://via.placeholder.com/400.png?text=Blue+Jeans', 49.99],
      ['Green Hoodie','Cozy green hoodie',            'https://via.placeholder.com/400.png?text=Green+Hoodie',39.99],
    ];

    await db.query(
      'INSERT INTO products (title, description, image_url, price) VALUES ?',
      [dummy]
    );

    res.send('Dummy products inserted into DB.');
  } catch (err) {
    console.error('Seeding error:', err);
    res.status(500).send('Failed to seed products.');
  }
});

// ------------------------------------------------------------------
// STEP 3: Sync Local Products to Shopify
// ------------------------------------------------------------------
app.get('/sync-products', async (req, res) => {
  try {
    // 1) Load one installed shop + token
    const [[installed]] = await db.execute(
      'SELECT shop, access_token FROM installed_shops LIMIT 1'
    );
    if (!installed) return res.status(400).send('No installed shop found.');

    const shopDomain = installed.shop;
    const accessToken = installed.access_token;

    // 2) Read local products
    const [rows] = await db.execute('SELECT * FROM products');
    if (rows.length === 0) return res.send('No products to sync.');

    // 3) Push each to Shopify
    await Promise.all(
      rows.map(product =>
        axios.post(
          `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json`,
          {
            product: {
              title: product.title,
              body_html: product.description,
              images: [{ src: product.image_url }],
              variants: [{ price: product.price }]
            }
          },
          {
            headers: {
              'X-Shopify-Access-Token': accessToken,
              'Content-Type': 'application/json'
            }
          }
        )
      )
    );

    res.send(`Successfully pushed ${rows.length} products to ${shopDomain}.`);
  } catch (err) {
    console.error('Sync error:', err.response?.data || err.message);
    res.status(500).send('Failed to sync products.');
  }
});

// ------------------------------------------------------------------
// STEP 4: Receive Order Webhook & Store in DB
// ------------------------------------------------------------------

// Health-check / friendly GET response
app.get('/webhook/orders/create', (req, res) => {
  res.send('✅ Webhook listener is up (POST-only)');
});

// The real Shopify webhook receiver (POST only)
app.post('/webhook/orders/create', async (req, res) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const generatedHash = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(req.body)
    .digest('base64');

  if (
    !crypto.timingSafeEqual(
      Buffer.from(hmacHeader, 'base64'),
      Buffer.from(generatedHash, 'base64')
    )
  ) {
    return res.status(401).send('HMAC validation failed');
  }

  try {
    const order = JSON.parse(req.body.toString());
    await db.execute(
      `INSERT INTO orders (shopify_order_id, email, total_price, created_at)
       VALUES (?, ?, ?, ?)`,
      [order.id, order.email, order.total_price, order.created_at]
    );
    res.status(200).send('Order stored.');
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Error storing order.');
  }
});
// ------------------------------------------------------------------
// STEP 6: Fetch Orders from Shopify & Store in DB
// ------------------------------------------------------------------
app.get('/fetch-orders', async (req, res) => {
  try {
    // 1) Load your installed shop + token
    const [[installed]] = await db.execute(
      'SELECT shop, access_token FROM installed_shops LIMIT 1'
    );
    if (!installed) {
      return res.status(400).send('No installed shop found.');
    }
    const shopDomain  = installed.shop;
    const accessToken = installed.access_token;

    // 2) Call Shopify Orders API (up to 250 orders per call)
    const ordersRes = await axios.get(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders.json`,
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type':       'application/json'
        },
        params: {
          status: 'any',   // fetch open, closed, cancelled…
          limit:  250      // max per request
        }
      }
    );
    const orders = ordersRes.data.orders || [];
    if (orders.length === 0) {
      return res.send('No orders found on Shopify.');
    }

    // 3) Upsert each order into your local DB
    await Promise.all(orders.map(order =>
      db.execute(
        `INSERT INTO orders
           (shopify_order_id, email, total_price, created_at)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           email = VALUES(email),
           total_price = VALUES(total_price),
           created_at = VALUES(created_at)`,
        [
          order.id,
          order.email   || null,
          order.total_price || 0,
          order.created_at
        ]
      )
    ));

    res.send(`Fetched & stored ${orders.length} orders.`);
  } catch (err) {
    console.error('Fetch-orders error:', err.response?.data || err.message);
    res.status(500).send('Failed to fetch or store orders.');
  }
});

// ------------------------------------------------------------------
// STEP 5: Start Server
// ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
