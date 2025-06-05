require('dotenv').config();
const express = require('express');
const { shopifyApi, LATEST_API_VERSION, MemorySessionStorage } = require('@shopify/shopify-api');
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
const URL = process.env.URL;

// MySQL DB pool
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
});

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

// Add a dashboard route to render the UI:
app.get('/dashboard', async (req, res) => {
  const [[{ count }]] = await db.execute('SELECT COUNT(*) AS count FROM products');
  res.render('dashboard', { productCount: count });
});

app.use(express.static(__dirname + '/public'));
// -- Raw body parser for webhooks
app.use('/webhook/orders/create', bodyParser.raw({ type: 'application/json' }));

app.get('/', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.send('Missing shop parameter.');

  const redirectUri = `${URL}/callback`; 
  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${process.env.SHOPIFY_SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(installUrl);
});

// ------------------------------------------------------------------
//  OAuth Callback
//   - validate HMAC
//   - exchange code → access_token
//   - persist to DB
//   - register webhook if not already
// ------------------------------------------------------------------
app.get('/callback', async (req, res) => {
  const { shop, code, hmac } = req.query;
  if (!shop || !code || !hmac) return res.send('Missing parameters.');

  // Validate HMAC
  const params = { ...req.query };
  delete params.hmac;
  delete params.signature;
  const message = new URLSearchParams(params).toString();
  const generatedHash = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(message)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(generatedHash, 'hex'))) {
    return res.send('HMAC validation failed.');
  }

  try {
    // Exchange code for access token
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

    // Fetch shop info
    const storeInfo = await axios.get(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const shopData = storeInfo.data.shop;

    // Check if user exists, else create user
    const [rows] = await db.execute('SELECT id FROM users WHERE email = ?', [shopData.email]);
    let userId;

    if (rows.length > 0) {
      userId = rows[0].id;
      console.log(userId);
    } else {
      try {
        const [insertUserResult] = await db.execute(
          'INSERT INTO users (email, name) VALUES (?, ?)',
          [shopData.email, shopData.shop_owner]
        );
        userId = insertUserResult.insertId;
        console.error('User insert sucessfull');
      } catch (insertErr) {
        console.error('User insert failed:', insertErr.message);
        return res.send('Failed to insert user.');
      }
    }

    // Insert or update shop info with user_id FK
    await db.execute(
      `INSERT INTO installed_shops (
        shop, access_token, email, shop_owner, shop_name, domain, myshopify_domain,
        plan_name, country, province, city, phone, currency, money_format,
        timezone, created_at_shop, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        access_token = VALUES(access_token),
        email = VALUES(email),
        shop_owner = VALUES(shop_owner),
        shop_name = VALUES(shop_name),
        domain = VALUES(domain),
        myshopify_domain = VALUES(myshopify_domain),
        plan_name = VALUES(plan_name),
        country = VALUES(country),
        province = VALUES(province),
        city = VALUES(city),
        phone = VALUES(phone),
        currency = VALUES(currency),
        money_format = VALUES(money_format),
        timezone = VALUES(timezone),
        created_at_shop = VALUES(created_at_shop),
        user_id = VALUES(user_id)
      `,
      [
        shop,
        accessToken,
        shopData.email,
        shopData.shop_owner,
        shopData.name,
        shopData.domain,
        shopData.myshopify_domain,
        shopData.plan_name,
        shopData.country_name,
        shopData.province,
        shopData.city,
        shopData.phone,
        shopData.currency,
        shopData.money_format,
        shopData.iana_timezone,
        shopData.created_at,
        userId
      ]
    );

    // Register the 'app/uninstalled' webhook
    try {
      await axios.post(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
        {
          webhook: {
            topic: 'app/uninstalled',
            address: `${URL}/webhook/app/uninstalled`,
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
      console.log('App uninstall webhook registered');
    } catch (webhookErr) {
      console.error('Webhook registration failed:', webhookErr.response?.data || webhookErr.message);
    }

    res.send('App installed & webhook registered.');
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.send('OAuth process failed.');
  }
});

app.get('/seed-products', async (req, res) => {
  try {
    const baseUrl = URL; // or 'http://localhost:3000'
    const dummy = [
      // [sku,        title,        description,             image_url,                  price]
      ['SKU-RED-01', 'Red T-Shirt', 'A bright red cotton tee', `${baseUrl}/images/red-tshirt.jpg`, 19.99],
      ['SKU-BLU-02', 'Blue Jeans', 'Classic blue denim jeans', `${baseUrl}/images/blue-jeans.jpg`, 49.99],
      ['SKU-GRN-03', 'Green Hoodie', 'Cozy green hoodie', `${baseUrl}/images/green-hoodie.jpg`, 39.99],
    ];

    await db.query(
      `INSERT IGNORE INTO products
         (sku, title, description, image_url, price)
       VALUES ?`,
      [dummy]
    );

    res.send('Dummy products inserted (existing SKUs ignored).');
  } catch (err) {
    console.error('Seeding error:', err);
    res.status(500).send('Failed to seed products.');
  }
});

// ------------------------------------------------------------------
// Sync Local Products to Shopify
// ------------------------------------------------------------------
app.get('/sync-products', async (req, res) => {
  try {
    const [[installed]] = await db.execute(
      'SELECT shop, access_token FROM installed_shops LIMIT 1'
    );
    if (!installed) return res.status(400).send('No installed shop found.');

    const shopDomain = installed.shop;
    const accessToken = installed.access_token;

    const [rows] = await db.execute('SELECT * FROM products');
    if (rows.length === 0) return res.send('No products to sync.');

    for (const product of rows) {
      const mutation = `
        mutation {
          productCreate(input: {
            title: "${product.title}",
            bodyHtml: "${product.description}",
            images: [{ src: "${product.image_url}" }],
            variants: [{ price: "${product.price}" }]
          }) {
            product {
              id
              title
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const response = await axios.post(
        `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        { query: mutation },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );

      const result = response.data;
      if (result.errors || result.data?.productCreate?.userErrors?.length > 0) {
        console.error('GraphQL Error:', JSON.stringify(result, null, 2));
        return res.status(500).send('Failed to sync some products.');
      }
    }

    res.send(`Successfully pushed ${rows.length} products to ${shopDomain} using GraphQL.`);
  } catch (err) {
    console.error('Sync error:', err.response?.data || err.message);
    res.status(500).send('Failed to sync products.');
  }
});

// ------------------------------------------------------------------
// Fetch Orders from Shopify & Store in DB
// ------------------------------------------------------------------
app.get('/fetch-orders', async (req, res) => {
  try {
    const [[installed]] = await db.execute(
      'SELECT shop, access_token FROM installed_shops LIMIT 1'
    );
    if (!installed) return res.status(400).send('No installed shop found.');

    const shopDomain = installed.shop;
    const accessToken = installed.access_token;

    const response = await axios.post(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      { query: gqlFetchOrders },
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        }
      }
    );

    const ordersData = response.data.data.orders.edges.map(edge => {
      const order = edge.node;
      return {
        id: order.id,
        name: order.name,
        createdAt: order.createdAt,
        total: order.totalPriceSet.shopMoney.amount,
        currency: order.totalPriceSet.shopMoney.currencyCode,
        customer: order.customer ? `${order.customer.firstName} ${order.customer.lastName}` : 'Guest',
        email: order.customer?.email || 'N/A',
        items: order.lineItems.edges.map(item => ({
          title: item.node.title,
          quantity: item.node.quantity,
          price: item.node.originalUnitPriceSet.shopMoney.amount
        }))
      };
    });

    res.json(ordersData);
  } catch (err) {
    console.error('Order fetch failed:', err.response?.data || err.message);
    res.status(500).send('Failed to fetch orders.');
  }
});

app.post('/webhook/app/uninstalled', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const rawBody = req.body; // This should be a Buffer

    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      console.warn('Webhook body is missing or not a Buffer.');
      return res.status(400).send('Invalid webhook payload.');
    }

    const hash = crypto
      .createHmac('sha256', SHOPIFY_API_SECRET)
      .update(rawBody)
      .digest('base64');

    if (hash !== hmacHeader) {
      console.warn('HMAC validation failed for uninstall webhook.');
      return res.status(401).send('Unauthorized');
    }

    const shop = req.headers['x-shopify-shop-domain'];
    if (shop) {
      await db.execute('DELETE FROM installed_shops WHERE shop = ?', [shop]);
      console.log(`App uninstalled by ${shop}`);
    }

    res.status(200).send('Webhook received');
  } catch (err) {
    console.error('Uninstall webhook error:', err.message);
    res.status(500).send('Webhook processing failed');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
