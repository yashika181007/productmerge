(() => {
  const params = new URLSearchParams(window.location.search);
  const shop = params.get('shop');
  if (!shop) return;

  fetch(`${window.location.origin}/apps/upsell/config?shop=${shop}`)
    .then(res => res.json())
    .then(cfg => {
      if (!cfg || !cfg.upsell_product_id) return;
      const widget = document.createElement('div');
      widget.innerHTML = `
        <div style="position:fixed; bottom:0; width:100%; background:#f9f9f9; padding:20px; box-shadow:0 -2px 5px rgba(0,0,0,0.1)">
          <h3>${cfg.headline}</h3><p>${cfg.description}</p>
          <button id="upsell-accept">Add for ₹${cfg.discount}</button>
        </div>`;
      document.body.appendChild(widget);

      document.getElementById('upsell-accept').onclick = () => {
        fetch(`/accept-upsell?shop=${shop}&product_id=${cfg.upsell_product_id}`);
      };
    });
})();
