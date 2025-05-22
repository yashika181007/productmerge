import { extension, AdminAction, BlockStack, Button, Text } from "@shopify/ui-extensions/admin";

// The target used here must match the target used in the extension's toml file (./shopify.extension.toml)
const TARGET = 'admin.product-details.action.render';

// The second argument to the render callback provides access to several useful APIs like i18n, close, and data.
export default extension(TARGET, (root, { i18n, close, data }) => {
  const productTitle = root.createText('');

  getProductInfo(data).then((title) => {
    productTitle.update(title);
  });

  root.append(
    root.createComponent(
      // The AdminAction component provides an API for setting the title and actions of the Action extension wrapper.
      AdminAction,
      {
        primaryAction: root.createComponent(Button, {
          onPress: () => {
            console.log("saving");
            close();
          },
        }, 'Done'),
        secondaryAction: root.createComponent(Button, {
          onPress: () => {
            console.log("closing");
            close();
          },
        }, 'Close')
      },
      root.createComponent(BlockStack, null,
        // Set the translation values for each supported language in the locales directory
        root.createComponent(Text, {fontWeight: 'bold'}, i18n.translate('welcome', {target: TARGET})),
        root.createComponent(Text, null, 'Current product: ', productTitle)
      )
    )
  );
});

// Use direct API calls to fetch data from Shopify.
// See https://shopify.dev/docs/api/admin-graphql for more information about Shopify's GraphQL API
async function getProductInfo(data) {
  const getProductQuery = {
    query: `query Product($id: ID!) {
      product(id: $id) {
        title
      }
    }`,
    variables: {id: data.selected[0].id},
  };

  const res = await fetch("shopify:admin/api/graphql.json", {
    method: "POST",
    body: JSON.stringify(getProductQuery),
  });

  if (!res.ok) {
    console.error('Network error');
  }

  const productData = await res.json();
  return productData.data.product.title;
};