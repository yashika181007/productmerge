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
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

// Add a dashboard route to render the UI:
app.get('/dashboard', async (req, res) => {

  const [[{ count }]] = await db.execute('SELECT COUNT(*) AS count FROM products');
  res.render('dashboard', { productCount: count });
});

// Serve static assets (CSS/JS):
app.use(express.static(__dirname + '/public'));
// -- Raw body parser for webhooks
app.use('/webhook/orders/create', bodyParser.raw({ type: 'application/json' }));


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
//  OAuth Callback
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

    const storeInfo = await axios.get(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
      {
        headers: {
          'X-Shopify-Access-Token': accessToken
        }
      }
    );
    const shopData = storeInfo.data.shop;
    console.log(shopData);

    await db.execute(
      `INSERT INTO installed_shops (
        shop, access_token, email, shop_owner, shop_name, domain, myshopify_domain,
        plan_name, country, province, city, phone, currency, money_format, timezone, created_at_shop
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        created_at_shop = VALUES(created_at_shop)
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
        shopData.created_at
      ]
    );

    const existing = await axios.get(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const hasOrderWebhook = existing.data.webhooks.some(wh =>
      wh.topic === 'orders/create' &&
      wh.address === `${NGROK_URL}/webhook/orders/create`
    );

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
app.get('/seed-products', async (req, res) => {
  try {
    const baseUrl = NGROK_URL; // or 'http://localhost:3000'
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
    // 1) Load one installed shop + token
    const [[installed]] = await db.execute(
      'SELECT shop, access_token FROM installed_shops LIMIT 1'
    );
    if (!installed) return res.status(400).send('No installed shop found.');

    const shopDomain = installed.shop;
    const accessToken = installed.access_token;

    const [rows] = await db.execute('SELECT * FROM products');
    if (rows.length === 0) return res.send('No products to sync.');

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
// Fetch Orders from Shopify & Store in DB
// ------------------------------------------------------------------
app.get('/fetch-orders', async (req, res) => {
  try {
    const [[installed]] = await db.execute(
      'SELECT shop, access_token FROM installed_shops LIMIT 1'
    );
    if (!installed) return res.status(400).send('No installed shop found.');

    const { shop: shopDomain, access_token: accessToken } = installed;

    const ordersRes = await axios.get(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders.json`,
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        },
        params: {
          status: 'any',
          limit: 250
        }
      }
    );

    const orders = ordersRes.data.orders || [];
    if (orders.length === 0) return res.send('No orders found.');

    for (const order of orders) {
      const customer = order.customer || {};
      const billing = order.billing_address || {};
      const shipping = order.shipping_address || {};

      // 1. Upsert Customer
      await db.execute(
        `INSERT INTO customers
         (shopify_customer_id, email, first_name, last_name, phone, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           email = VALUES(email),
           first_name = VALUES(first_name),
           last_name = VALUES(last_name),
           phone = VALUES(phone)`,
        [
          customer.id,
          customer.email,
          customer.first_name,
          customer.last_name,
          customer.phone,
          customer.created_at
        ]
      );

      const [[custRow]] = await db.execute(
        `SELECT id FROM customers WHERE shopify_customer_id = ?`,
        [customer.id]
      );

      // 2. Upsert Order
      await db.execute(
        `INSERT INTO orders
         (shopify_order_id, customer_id, email, total_price, financial_status, fulfillment_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           customer_id = VALUES(customer_id),
           email = VALUES(email),
           total_price = VALUES(total_price),
           financial_status = VALUES(financial_status),
           fulfillment_status = VALUES(fulfillment_status),
           updated_at = VALUES(updated_at)`,
        [
          order.id,
          custRow.id,
          order.email,
          order.total_price,
          order.financial_status,
          order.fulfillment_status,
          order.created_at,
          order.updated_at
        ]
      );

      // 3. Upsert Billing & Shipping Address (remove old first)
      await db.execute('DELETE FROM order_addresses WHERE shopify_order_id = ?', [order.id]);
      for (const type of ['billing', 'shipping']) {
        const addr = type === 'billing' ? billing : shipping;
        if (Object.keys(addr).length > 0) {
          await db.execute(
            `INSERT INTO order_addresses
             (shopify_order_id, type, name, address1, address2, city, province, country, zip, phone)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              order.id,
              type,
              addr.name,
              addr.address1,
              addr.address2,
              addr.city,
              addr.province,
              addr.country,
              addr.zip,
              addr.phone
            ]
          );
        }
      }

      // 4. Upsert Line Items (remove old first)
      await db.execute('DELETE FROM order_items WHERE shopify_order_id = ?', [order.id]);
      for (const item of order.line_items) {
        await db.execute(
          `INSERT INTO order_items
           (shopify_order_id, product_id, variant_id, title, quantity, price)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            order.id,
            item.product_id,
            item.variant_id,
            item.title,
            item.quantity,
            item.price
          ]
        );
      }
    }

    res.send(`Fetched & stored ${orders.length} orders (with customer, address, items).`);
  } catch (err) {
    console.error('Fetch-orders error:', err.response?.data || err.message);
    res.status(500).send('Failed to fetch/store full order data.');
  }
});

// ------------------------------------------------------------------
// Start Server
// ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
