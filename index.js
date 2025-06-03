require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const ShopifyPackage = require('@shopify/shopify-api');
const Shopify = ShopifyPackage.Shopify;
const ApiVersion = ShopifyPackage.ApiVersion;

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
const HOST = process.env.URL; // Your app public URL (https://yourapp.com)

// Initialize Shopify Context with MySQL session storage
async function initShopify() {
  await createSessionsTable(db);

  Shopify.Context.initialize({
    API_KEY: SHOPIFY_API_KEY,
    API_SECRET_KEY: SHOPIFY_API_SECRET,
    SCOPES: SCOPES.split(','),
    HOST_NAME: HOST.replace(/^https?:\/\//, ''),
    API_VERSION: ApiVersion.April23,
    IS_EMBEDDED_APP: false,
    SESSION_STORAGE: new MySQLSessionStorage(db),
  });

  console.log('Shopify context initialized with MySQL session storage.');
}

initShopify().catch(console.error);

app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
console.log('Shopify:', Shopify);
console.log('Shopify.Auth:', Shopify.Auth);

// Redirect to Shopify OAuth Install
app.get('/', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing shop parameter.');

  try {
    const authRoute = await Shopify.Auth.beginAuth(
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

// OAuth Callback
app.get('/callback', async (req, res) => {
  try {
    const session = await Shopify.Auth.validateAuthCallback(req, res, req.query); // throws on failure
    // session: { id, shop, state, isOnline, accessToken, scope }

    // Fetch shop info using Shopify API Client
    const client = new Shopify.Clients.Rest(session.shop, session.accessToken);
    const shopDataResponse = await client.get({
      path: 'shop',
    });
    const shopData = shopDataResponse.body.shop;

    // Upsert user
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

    // Upsert installed shop
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
      ]
    );

    // Register webhook: app/uninstalled
    try {
      await Shopify.Webhooks.Registry.register({
        shop: session.shop,
        accessToken: session.accessToken,
        path: '/webhook/app/uninstalled',
        topic: 'APP_UNINSTALLED',
        webhookHandler: async (topic, shop, body) => {
          console.log(`Received ${topic} webhook for shop ${shop}`);
          await db.execute('DELETE FROM installed_shops WHERE shop = ?', [shop]);
        },
      });
      console.log(`Webhook registration successful for ${session.shop}`);
    } catch (err) {
      console.error('Failed to register webhook:', err);
    }

    res.send('App installed successfully!');
  } catch (error) {
    console.error('Auth callback error:', error);
    res.status(400).send('Authentication failed.');
  }
});

// Webhook handler endpoint (needs raw body parsing)
app.post(
  '/webhook/app/uninstalled',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const topic = req.headers['x-shopify-topic'];
      const shop = req.headers['x-shopify-shop-domain'];
      const hmac = req.headers['x-shopify-hmac-sha256'];

      // Verify webhook
      const generatedHash = Shopify.Utils.generateHmac(req.body, SHOPIFY_API_SECRET);
      if (generatedHash !== hmac) {
        return res.status(401).send('HMAC validation failed');
      }

      console.log(`Webhook received: ${topic} from ${shop}`);

      // Remove shop from DB
      await db.execute('DELETE FROM installed_shops WHERE shop = ?', [shop]);

      res.status(200).send('Webhook handled');
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).send('Webhook failed');
    }
  }
);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
