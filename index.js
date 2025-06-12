require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const qs = require('qs');
const path = require('path');
require('@shopify/shopify-api/adapters/node');
const { shopifyApi, Session } = require('@shopify/shopify-api');
// Middlewares
const verifySessionToken = require('./middleware/verifySessionToken');
const verifyShopifyWebhook = require('./middleware/verifyShopifyWebhook');

const app = express();
const PORT = process.env.PORT || 3000;
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';
const URL = process.env.URL;
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(','),
  hostName: process.env.URL.replace(/^https?:\/\//, ''),
  isEmbeddedApp: true,
  apiVersion: process.env.SHOPIFY_API_VERSION || '2024-04',
});
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
});

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
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

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
    ['SKU-RED-011', 'Red1 T-Shirt', 'A bright red cotton tee', `${baseUrl}/images/red-tshirt.jpg`, 19.99],
    ['SKU-BLU-021', 'Blue1 Jeans', 'Classic blue denim jeans', `${baseUrl}/images/blue-jeans.jpg`, 49.99],
    ['SKU-GRN-031', 'Green1 Hoodie', 'Cozy green hoodie', `${baseUrl}/images/green-hoodie.jpg`, 39.99],
  ];
  await db.query(
    `INSERT IGNORE INTO products (sku, title, description, image_url, price) VALUES ?`,
    [dummy]
  );
  res.send('Dummy products inserted.');
});
// app.get('/sync-products', async (req, res) => {
//   console.log("🔄 Starting /sync-products...");
//   try {
//     const [[installed]] = await db.execute('SELECT shop, access_token FROM installed_shops LIMIT 1');
//     if (!installed) return res.status(400).send('No installed shop.');

//     console.log("🛍️ Installed shop info:", installed);

//     const session = new Session({
//       id: `${installed.shop}_session`,
//       shop: installed.shop,
//       accessToken: installed.access_token,
//       isOnline: false,
//     });
//     console.log("🔐 Session created:", session);

//     const client = new shopify.clients.Graphql({ session });
//     console.log("📡 GraphQL client initialized");

//     const [products] = await db.execute('SELECT * FROM products');
//     console.log(`📦 Found ${products.length} products in DB.`);

//     let createdCount = 0;

//     for (const product of products) {
//       console.log(`➡️ Attempting product: ${product.title}`);
//       try {
//         const mutation = `
//           mutation productCreate($product: ProductCreateInput!) {
//             productCreate(product: $product) {
//               product {
//                 id
//                 title
//               }
//               userErrors {
//                 field
//                 message
//               }
//             }
//           }
//         `;

//         const variables = {
//           product: {
//             title: product.title,
//             descriptionHtml: product.description || '',
//             vendor: "My Vendor",
//             productType: "General",
//           },
//         };

//         console.log('📤 Sending mutation with variables:', variables);

//         const response = await client.query({
//           data: {
//             query: mutation,
//             variables,
//           },
//         });

//         const result = response.body.data.productCreate;

//         if (result.userErrors.length) {
//           console.error(`❌ User Errors for "${product.title}":`, result.userErrors);
//           continue;
//         }

//         const productId = result.product.id;
//         console.log(`✅ Created: ${result.product.title} (${productId})`);
//         createdCount++;

//       } catch (err) {
//         console.error(`❌ Other Error while creating "${product.title}":`, err.message || err);
//       }
//     }

//     console.log(`🎉 Final status: ✅ Synced ${createdCount} of ${products.length} products.`);
//     res.send(`✅ Synced ${createdCount} of ${products.length} products.`);
//   } catch (err) {
//     console.error('❌ Critical /sync-products error:', err.message || err);
//     res.status(500).send('Internal Server Error');
//   }
// });

app.get('/sync-products', async (req, res) => {
  try {
    console.log('🚀 Starting product sync...');

    const [[installed]] = await db.execute('SELECT shop, access_token FROM installed_shops LIMIT 1');
    if (!installed) {
      console.log('❌ No installed shop found.');
      return res.status(400).send('No installed shop found.');
    }

    const shopDomain = installed.shop;
    const accessToken = installed.access_token;
    console.log(`🔐 Connected to shop: ${shopDomain}`);

    const [rows] = await db.execute('SELECT * FROM products');
    console.log(`📦 Found ${rows.length} products to sync.`);

    if (rows.length === 0) return res.send('No products to sync.');

    for (const product of rows) {
      console.log(`🔄 Syncing product: ${product.title}`);

      // ✅ Create Product Mutation (2024-10+ API fix)
      const createProductMutation = `
        mutation productCreate($input: ProductCreateInput!) {
          productCreate(input: $input) {
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

      const variables = {
        input: {
          title: product.title
        }
      };

      console.log('📡 Sending productCreate mutation with variables:', variables);

      const createProductResponse = await axios.post(
        `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          query: createProductMutation,
          variables
        },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );

      const responseData = createProductResponse.data;
      const productCreate = responseData?.data?.productCreate;
      const createdProduct = productCreate?.product;
      const userErrors = productCreate?.userErrors;

      console.log('createProductResponse.data', responseData);
      console.log('productCreate', productCreate);
      console.log('createdProduct', createdProduct);
      console.log('userErrors', userErrors);

      if (!createdProduct || (userErrors && userErrors.length)) {
        console.error('❌ Product creation failed:', JSON.stringify(userErrors, null, 2));
        continue;
      }

      console.log(`✅ Product created with ID: ${createdProduct.id}`);

      const productId = createdProduct.id;

      // ✅ Attach Image
      const imageMutation = `
        mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media {
              alt
              status
            }
            mediaUserErrors {
              field
              message
            }
          }
        }
      `;

      const imageVariables = {
        productId,
        media: [
          {
            originalSource: product.image_url,
            mediaContentType: "IMAGE"
          }
        ]
      };

      console.log(`🖼️ Attaching image to product ${product.title} from URL: ${product.image_url}`);

      const imageResponse = await axios.post(
        `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          query: imageMutation,
          variables: imageVariables
        },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );

      const mediaErrors = imageResponse.data?.data?.productCreateMedia?.mediaUserErrors;
      if (mediaErrors && mediaErrors.length) {
        console.warn(`⚠️ Image upload warnings for ${product.title}:`, JSON.stringify(mediaErrors, null, 2));
      } else {
        console.log(`🖼️ Image attached to product ${product.title}`);
      }

      // ✅ Create Variants
      const variantMutation = `
        mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            product {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const variantVariables = {
        productId,
        variants: [
          {
            price: product.price.toString(),
            sku: product.sku
          }
        ]
      };

      console.log(`🔢 Adding variant to product ${product.title}:`, variantVariables);

      const variantResponse = await axios.post(
        `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          query: variantMutation,
          variables: variantVariables
        },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
          }
        }
      );

      const variantErrors = variantResponse.data?.data?.productVariantsBulkCreate?.userErrors;
      if (variantErrors && variantErrors.length) {
        console.warn(`⚠️ Variant creation warnings for ${product.title}:`, JSON.stringify(variantErrors, null, 2));
      } else {
        console.log(`✅ Variant added for product ${product.title}`);
      }

      console.log(`🎉 Finished syncing product: ${product.title}`);
    }

    const successMessage = `✅ Successfully synced ${rows.length} products to ${shopDomain}`;
    console.log(successMessage);
    res.send(successMessage);
  } catch (err) {
    console.error('🔥 Sync error:', err.response?.data || err.message);
    res.status(500).send('Failed to sync products.');
  }
});

app.get('/fetch-orders', verifySessionToken, async (req, res) => {
  console.log('--- /fetch-orders called ---');

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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
