require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const qs = require('qs');
const path = require('path');
const db = require('./db');
// Middlewares
const verifySessionToken = require('./middleware/verifySessionToken');
const verifyShopifyWebhook = require('./middleware/verifyShopifyWebhook');

const app = express();
const PORT = process.env.PORT || 3000;
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION;
const URL = process.env.URL;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

const rawBodySaver = (req, res, buf) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString('utf8');
  }
};
app.use(bodyParser.json({ verify: rawBodySaver }));
app.use(bodyParser.urlencoded({ extended: true, verify: rawBodySaver }));

app.use((req, res, next) => {
  const shop = req.query.shop || req.headers['x-shopify-shop-domain'];
  let frameAncestors = `https://admin.shopify.com`;

  if (shop) {
    frameAncestors += ` https://${shop}`;
  }

  res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors};`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.get('/', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.send('Missing shop parameter.');

  const redirectUri = `${URL}/callback`;
  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${process.env.SHOPIFY_SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&grant_options[]=per-user`;
  res.redirect(installUrl);
});

app.get('/callback', async (req, res) => {
  const { shop, code, hmac, host, timestamp } = req.query;

  if (!shop || !code || !hmac || !host || !timestamp) {
    return res.send('Missing parameters.');
  }

  const params = { ...req.query };
  delete params['hmac'];
  delete params['signature'];

  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}=${Array.isArray(params[key]) ? params[key].join(',') : params[key]}`)
    .join('&');

  const generatedHash = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(sortedParams)
    .digest('hex');

  if (generatedHash !== hmac) {
    console.warn('Expected HMAC:', generatedHash);
    console.warn('Received HMAC:', hmac);
    return res.send('HMAC validation failed.');
  }

  try {
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

    const storeInfo = await axios.get(
      `https://${shop}/admin/api/${process.env.SHOPIFY_API_VERSION}/shop.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } }
    );

    const shopData = storeInfo.data.shop;

    const [rows] = await db.execute('SELECT id FROM users WHERE email = ?', [shopData.email]);
    let userId = rows.length > 0
      ? rows[0].id
      : (await db.execute(
        'INSERT INTO users (email, name) VALUES (?, ?)',
        [shopData.email, shopData.shop_owner]
      ))[0].insertId;

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
    await axios.post(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      query: `mutation {
                webhookSubscriptionCreate(
                  topic: APP_UNINSTALLED,
                  webhookSubscription: {
                    callbackUrl: "${URL}/webhooks/app-uninstalled",
                    format: JSON
                  }
                ) {
                  webhookSubscription {
                    id
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }`
    }, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });
    const cleanedShop = shopData.myshopify_domain;
    const baseUrl = URL;
    await axios.post(
      `https://${shop}/admin/api/${process.env.SHOPIFY_API_VERSION}/script_tags.json`,
      {
        script_tag: {
          event: "onload",
          src: `${process.env.URL}/upsell.js?shop=${cleanedShop}`
        }
      },
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    const redirectUrl = `${baseUrl}/apps/shipping-owl?host=${host}&shop=${cleanedShop}`;

    return res.redirect(redirectUrl);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send('OAuth process failed.');
  }
});

app.get('/apps/shipping-owl', async (req, res) => {
  const { shop, host } = req.query;

  if (!shop || !host) {
    return res.send('Missing shop or host.');
  }

  const [[{ count }]] = await db.execute('SELECT COUNT(*) AS count FROM products');
  res.render('dashboard', {
    productCount: count,
    shop,
    host,
    SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY
  });
});

app.get('/dashboard', async (req, res) => {
  const [[{ count }]] = await db.execute('SELECT COUNT(*) AS count FROM products');
  res.render('dashboard', { productCount: count });
});

app.get('/seed-products', async (req, res) => {

  const baseUrl = URL;
  const dummy = [
    ['SKU-RED-011', 'Red T-Shirt', 'A bright red cotton tee', `${baseUrl}/images/red-tshirt.jpg`, 19.99],
    ['SKU-BLU-021', 'Blue Jeans', 'Classic blue denim jeans', `${baseUrl}/images/blue-jeans.jpg`, 49.99],
    ['SKU-GRN-031', 'Green Hoodie', 'Cozy green hoodie', `${baseUrl}/images/green-hoodie.jpg`, 39.99],
  ];
  await db.query(
    `INSERT IGNORE INTO products (sku, title, description, image_url, price) VALUES ?`,
    [dummy]
  );
  res.send('Dummy products inserted.');
});

app.get('/sync-products', verifySessionToken, async (req, res) => {
  const shopDomain = req.shop;
  const [[installed]] = await db.execute(
    'SELECT access_token FROM installed_shops WHERE shop = ? LIMIT 1',
    [shopDomain]
  );
  if (!installed || !installed.access_token) {
    return res.status(400).send('No installed shop found.');
  }
  const accessToken = installed.access_token;

  const [rows] = await db.execute('SELECT * FROM products');
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.send('No products to sync.');
  }

  for (const product of rows) {
    const createProductMutation = `
      mutation productCreate($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            variants(first: 1) {
              edges {
                node {
                  id
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    const createVariables = {
      product: {
        title: product.title || '',
        descriptionHtml: product.description || '',
        vendor: 'Seeded Vendor',
        productType: 'Synced from App'
      }
    };
    const createResp = await axios.post(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      { query: createProductMutation, variables: createVariables },
      {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        }
      }
    );
    const productCreatePayload = createResp.data.data?.productCreate;
    console.log('productCreate:', JSON.stringify(productCreatePayload, null, 2));
    if (!productCreatePayload || !productCreatePayload.product) {
      continue;
    }
    const createdProduct = productCreatePayload.product;
    const variantEdges = createdProduct.variants?.edges;
    let defaultVariantId = null;
    if (Array.isArray(variantEdges) && variantEdges.length > 0) {
      defaultVariantId = variantEdges[0].node?.id || null;
    }
    console.log('Default Variant ID:', defaultVariantId);

    if (defaultVariantId) {
      const variantInput = { id: defaultVariantId };
      if (product.price != null && !isNaN(product.price)) {
        variantInput.price = product.price.toString();
      }
      if (product.sku) {
        variantInput.sku = product.sku;
      }
      if (Object.keys(variantInput).length > 1) {
        const variantUpdateMutation = `
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              userErrors {
                field
                message
              }
            }
          }
        `;
        const variantVariables = {
          productId: createdProduct.id,
          variants: [variantInput]
        };
        console.log('Updating variant with:', variantVariables);

        await axios.post(
          `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          { query: variantUpdateMutation, variables: variantVariables },
          {
            headers: {
              'X-Shopify-Access-Token': accessToken,
              'Content-Type': 'application/json'
            }
          }
        );
      }
    }

    if (product.image_url && product.image_url.startsWith('http')) {
      const imageMutation = `
        mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            mediaUserErrors {
              field
              message
            }
          }
        }
      `;
      const imageVariables = {
        productId: createdProduct.id,
        media: [{ originalSource: product.image_url, mediaContentType: 'IMAGE' }]
      };
      await axios.post(
        `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        { query: imageMutation, variables: imageVariables },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );
    }
  }

  return res.send(`Finished syncing ${rows.length} products.`);
});

app.get('/fetch-orders', verifySessionToken, async (req, res) => {
  try {
    const [[installed]] = await db.execute('SELECT shop, access_token FROM installed_shops LIMIT 1');
    console.log('Installed shop record:', installed);

    if (!installed) {
      console.log('No installed shop found');
      return res.status(400).send('No installed shop.');
    }

    const gql = `{
      orders(first: 10, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            currencyCode
            totalPriceSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount currencyCode } }
            totalShippingPriceSet { shopMoney { amount currencyCode } }
            totalTaxSet { shopMoney { amount currencyCode } }
            displayFinancialStatus
            displayFulfillmentStatus
            customer {
              id
              email
              firstName
              lastName
              phone
            }
            billingAddress {
              address1
              address2
              city
              province
              country
              zip
              phone
            }
            shippingAddress {
              address1
              address2
              city
              province
              country
              zip
              phone
            }
            lineItems(first: 50) {
              edges {
                node {
                  title
                  sku
                  quantity
                  discountedTotalSet { shopMoney { amount currencyCode } }
                  originalTotalSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
        }
      }
    }`;

    console.log('Sending GraphQL query to Shopify...');
    const response = await axios.post(
      `https://${installed.shop}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`,
      { query: gql },
      { headers: { 'X-Shopify-Access-Token': installed.access_token } }
    );

    console.log('Received response from Shopify');
    if (response.data.errors) {
      console.error('GraphQL errors:', response.data.errors);
      return res.status(500).send('GraphQL errors from Shopify');
    }

    const orders = response.data.data.orders.edges.map(edge => edge.node);
    console.log(`Fetched ${orders.length} orders`);

    for (const order of orders) {
      console.log(`Processing order ${order.id} (${order.name})`);
      const customerName = `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim();

      try {
        // Insert or update order in DB
        const [result] = await db.execute(
          `INSERT INTO orders (
            shopify_order_id, name, created_at, financial_status, fulfillment_status,
            total, subtotal, shipping, tax, currency,
            customer_id, customer_name, customer_email, customer_phone,
            billing_address, shipping_address
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            name=VALUES(name),
            created_at=VALUES(created_at),
            financial_status=VALUES(financial_status),
            fulfillment_status=VALUES(fulfillment_status),
            total=VALUES(total),
            subtotal=VALUES(subtotal),
            shipping=VALUES(shipping),
            tax=VALUES(tax),
            currency=VALUES(currency),
            customer_id=VALUES(customer_id),
            customer_name=VALUES(customer_name),
            customer_email=VALUES(customer_email),
            customer_phone=VALUES(customer_phone),
            billing_address=VALUES(billing_address),
            shipping_address=VALUES(shipping_address)`,
          [
            order.id,
            order.name,
            order.createdAt,
            order.displayFinancialStatus,
            order.displayFulfillmentStatus,
            order.totalPriceSet.shopMoney.amount,
            order.subtotalPriceSet.shopMoney.amount,
            order.totalShippingPriceSet.shopMoney.amount,
            order.totalTaxSet.shopMoney.amount,
            order.currencyCode,
            order.customer?.id || '',
            customerName,
            order.customer?.email || '',
            order.customer?.phone || '',
            JSON.stringify(order.billingAddress || {}),
            JSON.stringify(order.shippingAddress || {})
          ]
        );
        console.log(`Order ${order.id} saved/updated`);

        // Remove existing line items before inserting new ones
        await db.execute('DELETE FROM order_line_items WHERE order_id = ?', [order.id]);
        console.log(`Deleted previous line items for order ${order.id}`);

        // Insert line items
        for (const li of order.lineItems.edges) {
          const item = li.node;
          await db.execute(
            `INSERT INTO order_line_items (
              order_id, title, sku, quantity, price, discounted_total
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              order.id,
              item.title,
              item.sku,
              item.quantity,
              item.originalTotalSet.shopMoney.amount,
              item.discountedTotalSet.shopMoney.amount
            ]
          );
          console.log(`Inserted line item "${item.title}" for order ${order.id}`);
        }
      } catch (dbError) {
        console.error(`DB error while processing order ${order.id}:`, dbError.message);
      }
    }

    res.send(`Fetched and stored ${orders.length} orders.`);
  } catch (err) {
    console.error('Fetch orders error:', err.response?.data || err.message || err);
    res.status(500).send('Failed to fetch orders');
  }
});

// app.post('/webhooks/app-uninstalled', verifyShopifyWebhook, async (req, res) => {
//   const shop = req.headers['x-shopify-shop-domain'];
//   if (shop) {
//     await db.execute('DELETE FROM installed_shops WHERE shop = ?', [shop]);
//     console.log(`App uninstalled for shop: ${shop}`);
//   }
//   res.status(200).send('Received');
// });
app.get('/apps/upsell/campaigns', verifySessionToken, async (req, res) => {
  const shop = req.query.shop;
  console.log('[GET /apps/upsell/campaigns] Shop:', shop);

  const [rows] = await db.execute("SELECT * FROM upsell_campaigns WHERE shop = ?", [shop]);
  console.log('[GET /apps/upsell/campaigns] Campaigns fetched:', rows.length);

  res.render('campaigns', { shop, campaigns: rows });
});

app.post('/apps/upsell/campaigns', verifySessionToken, async (req, res) => {
  const { shop, trigger_product_id, upsell_product_id, headline, description, discount } = req.body;
  console.log('[POST /apps/upsell/campaigns] Form data received:', req.body);

  await db.execute(
    `INSERT INTO upsell_campaigns
     (shop, trigger_product_id, upsell_product_id, headline, description, discount, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    [shop, trigger_product_id, upsell_product_id, headline, description, discount]
  );

  console.log('[POST /apps/upsell/campaigns] Campaign inserted into DB');
  res.redirect(`/apps/upsell/campaigns?shop=${shop}`);
});

app.get('/apps/upsell/config', async (req, res) => {
  const { shop } = req.query;
  console.log('[GET /apps/upsell/config] Shop:', shop);

  const [[cfg]] = await db.execute(
    `SELECT * FROM upsell_campaigns WHERE shop = ? AND status = 'active' LIMIT 1`,
    [shop]
  );

  console.log('[GET /apps/upsell/config] Active campaign config:', cfg);
  res.json(cfg || {});
});

app.get('/accept-upsell', async (req, res) => {
  const { shop, product_id } = req.query;
  console.log('[GET /accept-upsell] Params:', req.query);

  const [[inst]] = await db.execute("SELECT access_token FROM installed_shops WHERE shop = ?", [shop]);
  if (!inst) {
    console.error('[GET /accept-upsell] Shop not found in DB');
    return res.status(400).send('Shop not found');
  }

  console.log('[GET /accept-upsell] Access token found');

  try {
    const prod = await axios.get(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/products/${product_id}.json`, {
      headers: { "X-Shopify-Access-Token": inst.access_token }
    });

    console.log('[GET /accept-upsell] Product fetched:', prod.data.product.title);
    const varId = prod.data.product.variants[0].id;

    console.log('[GET /accept-upsell] Variant ID:', varId);

    res.redirect(`https://${shop}/cart/${varId}:1`);

    console.log('[GET /accept-upsell] Added to cart via AJAX');
  } catch (err) {
    console.error('[GET /accept-upsell] Error:', err.response?.data || err.message);
  }

  res.redirect('/apps/upsell/upsell_thank_you?shop=' + shop);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
