require('dotenv').config();
const express = require('express');
const { shopifyApi, MemorySessionStorage } = require('@shopify/shopify-api');
const axios = require('axios');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const qs = require('qs');

const app = express();
const PORT = process.env.PORT || 3000;
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';
const URL = process.env.URL;

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
});

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.static(__dirname + '/public'));
app.use('/webhook/orders/create', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.raw({ type: 'application/json' }));
function verifyShopifyWebhook(req, res, next) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const body = req.body; // raw body as buffer
  const secret = process.env.SHOPIFY_API_SECRET;

  const hash = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');

  if (hash !== hmac) {
    console.warn('❌ Webhook HMAC validation failed.');
    return res.status(401).send('Unauthorized');
  }

  // If valid, parse body into JSON
  try {
    req.body = JSON.parse(body.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Invalid JSON');
  }

  next();
}
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

app.get('/callback', async (req, res) => {
  const { shop, code, hmac, host } = req.query;

  if (!shop || !code || !hmac || !host) return res.send('Missing parameters.');

  // HMAC validation
  const params = { ...req.query };
  delete params.hmac;
  delete params.signature;
  const message = new URLSearchParams(params).toString();
  const generatedHash = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(message)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(generatedHash, 'hex'))) {
    return res.send('HMAC validation failed.');
  }

  try {
    // Get access token
    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      qs.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data.access_token;

    // Get shop info
    const storeInfo = await axios.get(
      `https://${shop}/admin/api/${process.env.SHOPIFY_API_VERSION}/shop.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );
    const shopData = storeInfo.data.shop;

    // Save user
    const [rows] = await db.execute('SELECT id FROM users WHERE email = ?', [shopData.email]);
    let userId = rows.length > 0
      ? rows[0].id
      : (await db.execute(
        'INSERT INTO users (email, name) VALUES (?, ?)',
        [shopData.email, shopData.shop_owner]
      ))[0].insertId;

    // Save shop
    await db.execute(
      `INSERT INTO installed_shops (
        shop, access_token, email, shop_owner, shop_name, domain, myshopify_domain,
        plan_name, country, province, city, phone, currency, money_format,
        timezone, created_at_shop, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE access_token=VALUES(access_token), email=VALUES(email),
        shop_owner=VALUES(shop_owner), shop_name=VALUES(shop_name),
        domain=VALUES(domain), myshopify_domain=VALUES(myshopify_domain),
        plan_name=VALUES(plan_name), country=VALUES(country), province=VALUES(province),
        city=VALUES(city), phone=VALUES(phone), currency=VALUES(currency),
        money_format=VALUES(money_format), timezone=VALUES(timezone),
        created_at_shop=VALUES(created_at_shop), user_id=VALUES(user_id)`,
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

    // Webhooks
    const webhookTopics = [
      { topic: 'CUSTOMERS_DATA_REQUEST', path: '/webhook/customers/data_request' },
      { topic: 'CUSTOMERS_REDACT', path: '/webhook/customers/redact' },
      { topic: 'SHOP_REDACT', path: '/webhook/shop/redact' }
    ];

    for (const { topic, path } of webhookTopics) {
      const mutation = `
        mutation {
          webhookSubscriptionCreate(topic: ${topic}, webhookSubscription: {
            callbackUrl: "${process.env.APP_URL}${path}",
            format: JSON
          }) {
            webhookSubscription { id }
            userErrors { field message }
          }
        }
      `;
      await axios.post(
        `https://${shop}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`,
        { query: mutation },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );
    }

    // ✅ Final redirect to embedded app URL
    return res.redirect(`https://admin.shopify.com/store/${shop.replace('.myshopify.com', '')}/apps/shipping-owl?host=${host}`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send('OAuth process failed.');
  }
});
app.get('/apps/shipping-owl', (req, res) => {
  const { shop } = req.query;

  // Set proper Content-Security-Policy for embedded apps
  res.setHeader('Content-Security-Policy', `frame-ancestors https://${shop} https://admin.shopify.com`);

  res.send(`<h1>Welcome to Shipping Owl for ${shop}</h1>`);
});
app.post('/webhook/customers/data_request', (req, res) => {
  console.log('Data request webhook');
  res.status(200).send('OK');
});

app.post('/webhook/customers/redact', (req, res) => {
  console.log('Customer redact webhook');
  res.status(200).send('OK');
});

app.post('/webhook/shop/redact', (req, res) => {
  console.log('Shop redact webhook');
  res.status(200).send('OK');
});

app.get('/dashboard', async (req, res) => {
  const [[{ count }]] = await db.execute('SELECT COUNT(*) AS count FROM products');
  res.render('dashboard', { productCount: count });
});

app.get('/seed-products', async (req, res) => {
  const baseUrl = URL;
  const dummy = [
    ['SKU-RED-01', 'Red T-Shirt', 'A bright red cotton tee', `${baseUrl}/images/red-tshirt.jpg`, 19.99],
    ['SKU-BLU-02', 'Blue Jeans', 'Classic blue denim jeans', `${baseUrl}/images/blue-jeans.jpg`, 49.99],
    ['SKU-GRN-03', 'Green Hoodie', 'Cozy green hoodie', `${baseUrl}/images/green-hoodie.jpg`, 39.99],
  ];
  await db.query(`INSERT IGNORE INTO products (sku, title, description, image_url, price) VALUES ?`, [dummy]);
  res.send('Dummy products inserted.');
});

app.get('/sync-products', async (req, res) => {
  const [[installed]] = await db.execute('SELECT shop, access_token FROM installed_shops LIMIT 1');
  if (!installed) return res.status(400).send('No installed shop.');

  const shop = installed.shop;
  const token = installed.access_token;
  const [products] = await db.execute('SELECT * FROM products');

  for (const product of products) {
    const createProductMutation = `
      mutation productCreate($input: ProductInput!) {
        productCreate(product: $input) {
          product { id title }
          userErrors { field message }
        }
      }`;

    const productInput = { title: product.title };

    const { data } = await axios.post(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        query: createProductMutation,
        variables: { input: productInput }
      },
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    const productCreateResponse = data.data?.productCreate;
    if (!productCreateResponse || productCreateResponse.userErrors.length > 0) {
      console.error('Product creation failed:', productCreateResponse?.userErrors || data.errors);
      continue;
    }

    const productId = productCreateResponse.product.id;

    // Media
    await axios.post(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        query: `
          mutation {
            productCreateMedia(productId: "${productId}", media: [{
              originalSource: "${product.image_url}", mediaContentType: IMAGE
            }]) {
              media { alt status }
              mediaUserErrors { message }
            }
          }
        `
      },
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    // Variants
    await axios.post(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        query: `
          mutation {
            productVariantsBulkCreate(productId: "${productId}", variants: [{
              price: "${product.price}", sku: "${product.sku}"
            }]) {
              product { id }
              userErrors { field message }
            }
          }
        `
      },
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );
  }

  res.send(`Synced ${products.length} products.`);
});

app.get('/fetch-orders', async (req, res) => {
  const [[installed]] = await db.execute('SELECT shop, access_token FROM installed_shops LIMIT 1');
  const gql = `{
    orders(first: 10, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id name createdAt
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { firstName lastName email }
          lineItems(first: 5) {
            edges { node { title quantity discountedTotalSet { shopMoney { amount } } } }
          }
        }
      }
    }
  }`;
  const response = await axios.post(`https://${installed.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, { query: gql }, { headers: { 'X-Shopify-Access-Token': installed.access_token } });
  res.json(response.data.data.orders.edges.map(edge => edge.node));
});

app.post('/webhook/app/uninstalled', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const rawBody = req.body;
  const hash = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(rawBody).digest('base64');
  if (hash !== hmacHeader) return res.status(401).send('Unauthorized');

  const shop = req.headers['x-shopify-shop-domain'];
  if (shop) await db.execute('DELETE FROM installed_shops WHERE shop = ?', [shop]);
  res.status(200).send('Webhook received');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
