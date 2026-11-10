/* Siluet multiship: split the cart between addresses, show DHL prices, pay once. */
(() => {
  const root = document.querySelector('[data-siluet-ms]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';

  const $ = (sel) => root.querySelector(sel);
  const proxy = `${(root.dataset.root || '/').replace(/\/$/, '')}/apps/multiship`;
  const countries = JSON.parse($('[data-ms-countries]').textContent || '[]');
  const currency = (window.Shopify && Shopify.currency && Shopify.currency.active) || root.dataset.currency;
  const rate = Number((window.Shopify && Shopify.currency && Shopify.currency.rate) || 1);
  const money = (n) => new Intl.NumberFormat(document.documentElement.lang || 'en', { style: 'currency', currency }).format(n);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let items = [];       // [{variantId, title, quantity}]
  let recipients = [];  // [{id, address:{...}, alloc:{variantId: qty}}]
  let quote = null;     // last quote from the server
  let ddp = {};         // recipient id -> true
  let seq = 0;

  const blankAddress = () => ({ name: '', phone: '', address1: '', address2: '', city: '', provinceCode: '', zip: '', countryCode: '' });
  const newRecipient = () => ({ id: `r${++seq}`, address: blankAddress(), alloc: {} });

  async function loadCart() {
    const cart = await fetch(`${window.Shopify?.routes?.root || '/'}cart.js`).then((r) => r.json());
    const merged = {};
    for (const l of cart.items) {
      const id = String(l.variant_id);
      if (!merged[id]) merged[id] = { variantId: id, title: l.product_title + (l.variant_title ? ` · ${l.variant_title}` : ''), quantity: 0 };
      merged[id].quantity += l.quantity;
    }
    items = Object.values(merged);
    if (!recipients.length) {
      recipients = [newRecipient(), newRecipient()];
      for (const it of items) recipients[0].alloc[it.variantId] = it.quantity;
    }
  }

  const assigned = (variantId) => recipients.reduce((s, r) => s + (r.alloc[variantId] || 0), 0);
  const leftTotal = () => items.reduce((s, it) => s + it.quantity - assigned(it.variantId), 0);
  const countFor = (r) => Object.values(r.alloc).reduce((s, n) => s + n, 0);

  function ready() {
    if (leftTotal() !== 0) return false;
    const used = recipients.filter((r) => countFor(r) > 0);
    if (used.length < 2) return false;
    return used.every((r) => r.address.name && r.address.address1 && r.address.city && r.address.countryCode && r.address.phone);
  }

  function invalidate() {
    quote = null;
    $('[data-ms-summary]').innerHTML = '';
    for (const el of root.querySelectorAll('[data-ms-price]')) el.innerHTML = '';
    refreshState();
  }

  function refreshState() {
    const left = leftTotal();
    $('[data-ms-left]').textContent = left > 0 ? `${left} piece${left > 1 ? 's' : ''} still to place` : '';
    $('[data-ms-quote]').disabled = !ready();
    root.querySelectorAll('[data-ms-recipient]').forEach((card) => {
      const r = recipients.find((x) => x.id === card.dataset.msRecipient);
      card.querySelectorAll('[data-ms-qty]').forEach((q) => { q.textContent = r.alloc[q.dataset.msQty] || 0; });
      card.querySelectorAll('[data-ms-plus]').forEach((b) => { b.disabled = assigned(b.dataset.msPlus) >= items.find((i) => i.variantId === b.dataset.msPlus).quantity; });
      card.querySelectorAll('[data-ms-minus]').forEach((b) => { b.disabled = !(r.alloc[b.dataset.msMinus] > 0); });
    });
  }

  function field(r, key, label, opts = {}) {
    const v = esc(r.address[key]);
    return `<label class="siluet-ms__field${opts.half ? ' siluet-ms__field--half' : ''}">
      <span>${label}${opts.optional ? ' <em>(optional)</em>' : ''}</span>
      <input data-ms-input="${key}" value="${v}" autocomplete="${opts.ac || 'off'}" ${opts.type ? `type="${opts.type}"` : ''}>
    </label>`;
  }

  function render() {
    const list = $('[data-ms-recipients]');
    list.innerHTML = recipients.map((r, i) => `
      <fieldset class="siluet-ms__card" data-ms-recipient="${r.id}">
        <legend>Address ${i + 1}</legend>
        ${recipients.length > 2 ? `<button type="button" class="siluet-ms__remove" data-ms-remove="${r.id}" aria-label="Remove address ${i + 1}">Remove</button>` : ''}
        ${field(r, 'name', 'Full name', { ac: 'name' })}
        ${field(r, 'address1', 'Address', { ac: 'address-line1' })}
        ${field(r, 'address2', 'Apartment, suite', { optional: true, ac: 'address-line2' })}
        ${field(r, 'city', 'City', { half: true, ac: 'address-level2' })}
        ${field(r, 'zip', 'Postcode', { half: true, optional: true, ac: 'postal-code' })}
        ${field(r, 'provinceCode', 'State code', { half: true, optional: true })}
        <label class="siluet-ms__field siluet-ms__field--half"><span>Country</span>
          <select data-ms-input="countryCode">
            <option value="">Choose</option>
            ${countries.map((c) => `<option value="${c.code}"${c.code === r.address.countryCode ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </label>
        ${field(r, 'phone', 'Phone (DHL needs it for delivery)', { ac: 'tel', type: 'tel' })}
        <div class="siluet-ms__items">
          <span class="siluet-ms__label">Pieces for this address</span>
          ${items.map((it) => `
            <div class="siluet-ms__item">
              <span class="siluet-ms__item-title">${esc(it.title)}</span>
              <span class="siluet-ms__stepper">
                <button type="button" data-ms-minus="${it.variantId}" aria-label="One less">−</button>
                <span data-ms-qty="${it.variantId}">0</span>
                <button type="button" data-ms-plus="${it.variantId}" aria-label="One more">+</button>
              </span>
            </div>`).join('')}
        </div>
        <div class="siluet-ms__price" data-ms-price></div>
      </fieldset>`).join('');
    refreshState();
  }

  function renderQuote() {
    const byId = Object.fromEntries(quote.quotes.map((q) => [q.id, q]));
    let total = 0;
    root.querySelectorAll('[data-ms-recipient]').forEach((card) => {
      const q = byId[card.dataset.msRecipient];
      const slot = card.querySelector('[data-ms-price]');
      if (!q) { slot.innerHTML = ''; return; }
      total += q.shipping.amount + (ddp[q.id] && q.ddp?.available ? q.ddp.amount : 0);
      slot.innerHTML = `
        <div class="siluet-ms__rate${q.free ? ' is-free' : ''}">
          <span>${esc(q.shipping.label)}</span>
          <strong>${q.free ? 'Free' : money(q.shipping.amount)}</strong>
        </div>
        ${q.ddp?.available ? `
          <label class="siluet-ms__ddp">
            <input type="checkbox" data-ms-ddp="${q.id}" ${ddp[q.id] ? 'checked' : ''}>
            <span>Prepay duties and taxes, nothing to pay on arrival <strong>${money(q.ddp.amount)}</strong></span>
          </label>` : ''}`;
    });
    $('[data-ms-summary]').innerHTML = `
      <div class="siluet-ms__total"><span>Shipping total</span><strong>${money(total)}</strong></div>
      <button type="button" class="siluet-ms__btn" data-ms-checkout>Check out</button>
      <p class="siluet-ms__note">Each address gets its own DHL parcel and tracking.</p>`;
  }

  function payload() {
    return {
      currency, rate, email: root.dataset.email || '',
      ddp,
      recipients: recipients
        .filter((r) => countFor(r) > 0)
        .map((r) => ({ id: r.id, address: r.address, lines: Object.entries(r.alloc).filter(([, q]) => q > 0).map(([variantId, quantity]) => ({ variantId, quantity })) })),
    };
  }

  async function post(path, button, busyText) {
    const err = $('[data-ms-error]');
    err.hidden = true;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    try {
      const res = await fetch(`${proxy}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Something went wrong. Please try again.');
      return json;
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      return null;
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  // Events
  root.addEventListener('input', (e) => {
    const card = e.target.closest('[data-ms-recipient]');
    if (card && e.target.dataset.msInput) {
      recipients.find((r) => r.id === card.dataset.msRecipient).address[e.target.dataset.msInput] = e.target.value;
      if (quote) invalidate(); else refreshState();
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.dataset.msDdp) { ddp[e.target.dataset.msDdp] = e.target.checked; renderQuote(); return; }
    if (e.target.dataset.msInput === 'countryCode') e.target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const card = t.closest('[data-ms-recipient]');
    const r = card && recipients.find((x) => x.id === card.dataset.msRecipient);
    if (t.dataset.msPlus) { r.alloc[t.dataset.msPlus] = (r.alloc[t.dataset.msPlus] || 0) + 1; invalidate(); }
    else if (t.dataset.msMinus) { r.alloc[t.dataset.msMinus] -= 1; invalidate(); }
    else if (t.dataset.msRemove) { recipients = recipients.filter((x) => x.id !== t.dataset.msRemove); delete ddp[t.dataset.msRemove]; render(); invalidate(); }
    else if (t.hasAttribute('data-ms-add')) { if (recipients.length < 10) { recipients.push(newRecipient()); render(); invalidate(); } }
    else if (t.hasAttribute('data-ms-quote')) {
      const q = await post('quote', t, 'Asking DHL…');
      if (q) { quote = q; renderQuote(); }
    } else if (t.hasAttribute('data-ms-checkout')) {
      const out = await post('checkout', t, 'Opening checkout…');
      if (out?.url) window.location.href = out.url;
    } else if (t.hasAttribute('data-ms-toggle')) {
      const panel = $('[data-ms-panel]');
      const open = panel.hidden;
      panel.hidden = !open;
      t.setAttribute('aria-expanded', String(open));
      if (open) { await loadCart(); render(); }
    }
  });
})();
