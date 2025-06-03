require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const axios = require('axios');
const {
  ApiVersion,
  Context,
  Auth,
  Clients,
  Webhooks,
  Utils,
} = require('@shopify/shopify-api');

const { MySQLSessionStorage, createSessionsTable } = require('./shopifySessionStorage');

const app = express();
const PORT = process.env.PORT || 3000;

const db = mysql.createPool({
  host: 'srv871.hstgr.io',
  user: 'u510451310_productmerge',
  password: 'U510451310_productmerge',
  database: 'u510451310_productmerge'
});

const SCOPES = process.env.SHOPIFY_SCOPES || 'read_products,write_products';
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const HOST = process.env.URL;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2023-04';

// ✅ Initialize Shopify Context
async function initShopify() {
  await createSessionsTable(db);

  Context.initialize({
    API_KEY: SHOPIFY_API_KEY,
    API_SECRET_KEY: SHOPIFY_API_SECRET,
    SCOPES: SCOPES.split(','),
    HOST_NAME: HOST.replace(/^https?:\/\//, ''),
    API_VERSION: ApiVersion.April23,
    IS_EMBEDDED_APP: false,
    SESSION_STORAGE: new MySQLSessionStorage(db),
  });

  console.log('✅ Shopify context initialized.');
}

initShopify().catch(console.error);

app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// 🔁 OAuth Start
app.get('/', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter.');

  try {
    const authRoute = await Auth.beginAuth(
      req,
      res,
      shop,
      '/callback',
      false
    );
    return res.redirect(authRoute);
  } catch (error) {
    console.error('Error starting auth:', error);
    return res.status(500).send('Failed to start auth.');
  }
});

// 🔁 OAuth Callback
app.get('/callback', async (req, res) => {
  try {
    const session = await Auth.validateAuthCallback(req, res, req.query);

    const client = new Clients.Rest(session.shop, session.accessToken);
    const shopDataResponse = await client.get({ path: 'shop' });
    const shopData = shopDataResponse.body.shop;

    const [rows] = await db.execute('SELECT id FROM users WHERE email = ?', [shopData.email]);
    let userId;

    if (rows.length > 0) {
      userId = rows[0].id;
    } else {
      const [insertUserResult] = await db.execute(
        'INSERT INTO users (email, name) VALUES (?, ?)',
        [shopData.email, shopData.shop_owner]
      );
      userId = insertUserResult.insertId;
    }

    await db.execute(`
      INSERT INTO installed_shops (
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
    `, [
      session.shop,
      session.accessToken,
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
      userId,
    ]);

    await Webhooks.Registry.register({
      shop: session.shop,
      accessToken: session.accessToken,
      path: '/webhook/app/uninstalled',
      topic: 'APP_UNINSTALLED',
      webhookHandler: async (topic, shop, body) => {
        console.log(`Webhook received: ${topic} from ${shop}`);
        await db.execute('DELETE FROM installed_shops WHERE shop = ?', [shop]);
      },
    });

    res.send('✅ App installed successfully!');
  } catch (error) {
    console.error('Auth callback error:', error);
    res.status(400).send('Authentication failed.');
  }
});

// 🔁 Webhook Endpoint
app.post(
  '/webhook/app/uninstalled',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const topic = req.headers['x-shopify-topic'];
      const shop = req.headers['x-shopify-shop-domain'];
      const hmac = req.headers['x-shopify-hmac-sha256'];

      const generatedHash = Utils.generateHmac(req.body, SHOPIFY_API_SECRET);
      if (generatedHash !== hmac) {
        return res.status(401).send('HMAC validation failed');
      }

      console.log(`Webhook received: ${topic} from ${shop}`);
      await db.execute('DELETE FROM installed_shops WHERE shop = ?', [shop]);

      res.status(200).send('Webhook handled');
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).send('Webhook failed');
    }
  }
);

// 🌱 Seed Dummy Products
app.get('/seed-products', async (req, res) => {
  try {
    const baseUrl = process.env.URL;
    const dummy = [
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

// 🔁 Sync Local DB Products to Shopify
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

// 🔁 Fetch Shopify Orders & Save to DB
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

    res.send(`Fetched & stored ${orders.length} orders.`);
  } catch (err) {
    console.error('Fetch-orders error:', err.response?.data || err.message);
    res.status(500).send('Failed to fetch/store full order data.');
  }
});

// 🔁 Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
