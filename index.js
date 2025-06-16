require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const qs = require('qs');
const path = require('path');
const db = require('./db');
const session = require('express-session');
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
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: false, // change to true if using HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 1 day
  }
}));
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

  res.setHeader("Content-Security-Policy", "frame-ancestors 'none';");

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
    req.session.shop = shop;
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
    // await axios.post(
    //   `https://${shop}/admin/api/${process.env.SHOPIFY_API_VERSION}/script_tags.json`,
    //   {
    //     script_tag: {
    //       event: "onload",
    //       src: `${process.env.URL}/upsell.js?shop=${cleanedShop}`
    //     }
    //   },
    //   { headers: { "X-Shopify-Access-Token": accessToken } }
    // );
    const redirectUrl = `${baseUrl}/dashboard?shop=${cleanedShop}`;
    return res.redirect(redirectUrl);
    ;
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send('OAuth process failed.');
  }
});

app.get('/dashboard', async (req, res) => {
  const { shop } = req.query;
  console.log(shop);
  const [[{ count }]] = await db.execute('SELECT COUNT(*) AS count FROM products');
  console.log(count);
  res.render('dashboard', {
    productCount: count,
    shop,
    SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY
  });
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

app.get('/sync-products', async (req, res) => {
  try {
    // 1. Get shopDomain from session
    const shopDomain = req.session?.shop;
    if (!shopDomain) {
      return res.status(401).send('Shop not found in session. Please login/install first.');
    }

    // 2. Get access token from DB
    const [[installed]] = await db.execute(
      'SELECT access_token FROM installed_shops WHERE shop = ? LIMIT 1',
      [shopDomain]
    );
    if (!installed || !installed.access_token) {
      return res.status(400).send('No installed shop found.');
    }
    const accessToken = installed.access_token;

    // 3. Fetch local products to sync
    const [rows] = await db.execute('SELECT * FROM products');
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.send('No products to sync.');
    }

    // 4. Prepare GraphQL mutation strings
    const productCreateMutation = `
      mutation productCreate($input: ProductCreateInput!) {
        productCreate(input: $input) {
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
    const imageCreateMutation = `
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          mediaUserErrors {
            field
            message
          }
        }
      }
    `;
    // (Optional) If you wish to publish the product so it's visible on the storefront:
    const publishMutation = `
      mutation publishProduct($id: ID!) {
        productPublish(id: $id) {
          userErrors {
            field
            message
          }
          product {
            id
          }
        }
      }
    `;

    // 5. Iterate through each local product
    for (const product of rows) {
      // Build input for productCreate
      const productInput = {
        title: product.title,
        descriptionHtml: product.description,
        vendor: product.vendor || 'Seeded Vendor',
        productType: product.product_type || 'Synced from App',
        // Note: GraphQL does not allow specifying variants directly here; default variant is created.
        // We'll update variant fields afterward.
      };
      // If you have more fields in your products table (e.g., tags, options), add them here according to ProductCreateInput docs.

      // 5a. Call productCreate
      let createResp;
      try {
        createResp = await axios.post(
          `https://${shopDomain}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`,
          {
            query: productCreateMutation,
            variables: { input: productInput }
          },
          {
            headers: {
              'X-Shopify-Access-Token': accessToken,
              'Content-Type': 'application/json'
            }
          }
        );
      } catch (networkErr) {
        console.error('[sync-products] Network/GQL request failed:', networkErr.response?.data || networkErr.message);
        continue; // Skip to next product
      }

      // 5b. Inspect response
      const respData = createResp.data;
      if (respData.errors) {
        console.error('[sync-products] GraphQL errors array:', respData.errors);
        continue;
      }
      const payload = respData.data?.productCreate;
      if (!payload) {
        console.error('[sync-products] productCreate payload missing:', JSON.stringify(respData, null, 2));
        continue;
      }
      if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
        console.error('[sync-products] productCreate userErrors:', payload.userErrors);
        continue;
      }
      const createdProduct = payload.product;
      if (!createdProduct) {
        console.error('[sync-products] productCreate returned no product, payload:', payload);
        continue;
      }

      console.log(`[sync-products] Created product ${createdProduct.id}`);

      // 5c. Get default variant ID
      const defaultVariantId = createdProduct.variants?.edges?.[0]?.node?.id;
      if (defaultVariantId) {
        // 5d. Build variant update input
        const variantInput = {};
        // Shopify expects at least id in each variant object
        variantInput.id = defaultVariantId;
        if (product.price != null && !isNaN(product.price)) {
          variantInput.price = product.price.toString();
        }
        if (product.sku) {
          variantInput.sku = product.sku;
        }
        // Add other variant fields if needed: compareAtPrice, inventoryPolicy, weight, etc.

        // Only call update if more than just id
        if (Object.keys(variantInput).length > 1) {
          try {
            const variantResp = await axios.post(
              `https://${shopDomain}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`,
              {
                query: variantUpdateMutation,
                variables: { productId: createdProduct.id, variants: [variantInput] }
              },
              {
                headers: {
                  'X-Shopify-Access-Token': accessToken,
                  'Content-Type': 'application/json'
                }
              }
            );
            const vdata = variantResp.data;
            if (vdata.errors) {
              console.error('[sync-products] productVariantsBulkUpdate errors:', vdata.errors);
            } else if (vdata.data?.productVariantsBulkUpdate.userErrors?.length) {
              console.error('[sync-products] productVariantsBulkUpdate userErrors:', vdata.data.productVariantsBulkUpdate.userErrors);
            } else {
              console.log(`[sync-products] Updated variant ${defaultVariantId} for product ${createdProduct.id}`);
            }
          } catch (variantErr) {
            console.error('[sync-products] Variant update failed:', variantErr.response?.data || variantErr.message);
          }
        }
      } else {
        console.warn(`[sync-products] No default variant ID returned for product ${createdProduct.id}`);
      }

      // 5e. Upload image/media if available
      if (product.image_url && product.image_url.startsWith('http')) {
        try {
          const imageResp = await axios.post(
            `https://${shopDomain}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`,
            {
              query: imageCreateMutation,
              variables: { productId: createdProduct.id, media: [{ originalSource: product.image_url, mediaContentType: 'IMAGE' }] }
            },
            {
              headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json'
              }
            }
          );
          const idata = imageResp.data;
          if (idata.errors) {
            console.error('[sync-products] productCreateMedia errors:', idata.errors);
          } else if (idata.data?.productCreateMedia.mediaUserErrors?.length) {
            console.error('[sync-products] productCreateMedia userErrors:', idata.data.productCreateMedia.mediaUserErrors);
          } else {
            console.log(`[sync-products] Uploaded image for product ${createdProduct.id}`);
          }
        } catch (imgErr) {
          console.error('[sync-products] Image upload failed:', imgErr.response?.data || imgErr.message);
        }
      }
      
      // 5f. (Optional) Publish product so it's visible on storefront
      if (product.publish === true) { 
        try {
          const pubResp = await axios.post(
            `https://${shopDomain}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`,
            {
              query: publishMutation,
              variables: { id: createdProduct.id }
            },
            {
              headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json'
              }
            }
          );
          const pdata = pubResp.data;
          if (pdata.errors) {
            console.error('[sync-products] publishProduct errors:', pdata.errors);
          } else if (pdata.data?.productPublish.userErrors?.length) {
            console.error('[sync-products] publishProduct userErrors:', pdata.data.productPublish.userErrors);
          } else {
            console.log(`[sync-products] Published product ${createdProduct.id}`);
          }
        } catch (pubErr) {
          console.error('[sync-products] Publish failed:', pubErr.response?.data || pubErr.message);
        }
      }
    } // end for each product

    return res.send(`Finished syncing ${rows.length} products.`);
  } catch (err) {
    console.error('[sync-products] Unexpected error:', err);
    return res.status(500).send('Failed to sync products.');
  }
});

app.get('/fetch-orders', async (req, res) => {
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

app.post('/webhooks/app-uninstalled', verifyShopifyWebhook, async (req, res) => {
  const shop = req.headers['x-shopify-shop-domain'];
  if (shop) {
    await db.execute('DELETE FROM installed_shops WHERE shop = ?', [shop]);
    console.log(`App uninstalled for shop: ${shop}`);
  }
  res.status(200).send('Received');
});

const fetchProductTitle = async (shop, accessToken, productId) => {
  try {
    const response = await axios.get(`https://${shop}/admin/api/2025-04/products/${productId}.json`, {
      headers: {
        'X-Shopify-Access-Token': accessToken
      }
    });
    return response.data.product?.title || 'Unknown';
  } catch (e) {
    console.error(`[fetchProductTitle] Error for ${productId}:`, e.response?.data || e.message);
    return 'Unknown';
  }
};

app.get('/apps/upsell/campaigns', async (req, res) => {
  const { shop } = req.query;
  const [rows] = await db.execute("SELECT * FROM upsell_campaigns WHERE shop = ?", [shop]);
  const [[{ access_token }]] = await db.execute("SELECT access_token FROM installed_shops WHERE shop = ?", [shop]);

  // Fetch all products from Shopify (simplified, paginated to first 50)
  let products = [];
  try {
    const response = await axios.get(`https://${shop}/admin/api/2025-04/products.json?limit=50`, {
      headers: { 'X-Shopify-Access-Token': access_token }
    });
    products = response.data.products.map(p => ({
      id: p.id,
      title: p.title
    }));
  } catch (e) {
    console.error('[Product Fetch Error]:', e.response?.data || e.message);
  }

  for (let row of rows) {
    row.trigger_product_title = await fetchProductTitle(shop, access_token, row.trigger_product_id);
    row.upsell_product_title = await fetchProductTitle(shop, access_token, row.upsell_product_id);
  }

  res.render('campaigns', { shop, campaigns: rows, products });
});

// Campaign creation (POST)
app.post('/apps/upsell/campaigns', async (req, res) => {
  const { shop, trigger_product_id, upsell_product_id, headline, description, discount } = req.body;
  if (!shop) return res.status(400).send('Missing shop parameter');

  await db.execute(
    `INSERT INTO upsell_campaigns
     (shop, trigger_product_id, upsell_product_id, headline, description, discount, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    [shop, trigger_product_id, upsell_product_id, headline, description, discount]
  );

  res.redirect(`/apps/upsell/campaigns?shop=${shop}`);
});

// Get active config (for frontend upsell injection)
app.get('/apps/upsell/config', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const [[cfg]] = await db.execute(
    `SELECT * FROM upsell_campaigns WHERE shop = ? AND status = 'active' LIMIT 1`,
    [shop]
  );
  res.json(cfg || {});
});

// Accept upsell (adds variant to cart and redirects)
app.get('/accept-upsell', async (req, res) => {
  const { shop, product_id } = req.query;
  if (!shop || !product_id) return res.status(400).send('Missing shop or product_id');

  const [[inst]] = await db.execute("SELECT access_token FROM installed_shops WHERE shop = ?", [shop]);
  if (!inst) return res.status(400).send('Shop not found');

  try {
    const productRes = await axios.get(`https://${shop}/admin/api/2024-04/products/${product_id}.json`, {
      headers: { "X-Shopify-Access-Token": inst.access_token }
    });

    const varId = productRes.data.product.variants[0].id;
    return res.redirect(`https://${shop}/cart/${varId}:1`);
  } catch (err) {
    console.error('[GET /accept-upsell] Error:', err.response?.data || err.message);
    return res.status(500).send('Failed to add upsell');
  }
});
// GET: Edit form
app.get('/apps/upsell/campaigns/edit', async (req, res) => {
  const { id, shop } = req.query;
  const [[campaign]] = await db.execute("SELECT * FROM upsell_campaigns WHERE id = ?", [id]);
  res.render('edit_campaign', { campaign, shop });
});

app.post('/apps/upsell/campaigns/edit', async (req, res) => {
  const { id, shop, trigger_product_id, upsell_product_id, headline, description, discount } = req.body;
  await db.execute(
    `UPDATE upsell_campaigns SET trigger_product_id = ?, upsell_product_id = ?, headline = ?, description = ?, discount = ? WHERE id = ?`,
    [trigger_product_id, upsell_product_id, headline, description, discount, id]
  );
  res.redirect(`/apps/upsell/campaigns?shop=${shop}`);
});

// POST: Delete
app.post('/apps/upsell/campaigns/delete', async (req, res) => {
  const { id, shop } = req.body;
  await db.execute("DELETE FROM upsell_campaigns WHERE id = ?", [id]);
  res.redirect(`/apps/upsell/campaigns?shop=${shop}`);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
