/* Siluet gifting: split the bag between people, show DHL prices, pay once.
   Used in a sheet (cart drawer, cart page, product page) and inline (Gifting page). */
(() => {
  if (window.SiluetGifting) return;

  const cfgEl = document.getElementById('siluet-ms-config');
  const cfg = cfgEl ? JSON.parse(cfgEl.textContent) : {};
  const root = (cfg.root || '/').replace(/\/$/, '');
  const proxy = `${root}/apps/multiship`;
  const currency = () => (window.Shopify?.currency?.active) || cfg.currency || 'USD';
  const rate = () => Number(window.Shopify?.currency?.rate || 1);
  const money = (n) => new Intl.NumberFormat(document.documentElement.lang || 'en', { style: 'currency', currency: currency() }).format(n);
  const moneyCents = (c) => money(c / 100);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const decode = (t) => { const x = document.createElement('textarea'); x.innerHTML = t; return x.value; };
  const countries = (cfg.countries || []).map((c) => ({ code: c.code, name: decode(c.name) }));
  const MAX_PEOPLE = 10;

  const blankAddress = () => ({ name: '', phone: '', address1: '', address2: '', city: '', provinceCode: '', zip: '', countryCode: cfg.country || '' });

  class GiftFlow {
    constructor(el, { inline = false, title, intro, onClose } = {}) {
      this.el = el;
      this.inline = inline;
      this.title = title || cfg.title || 'Send to several people';
      this.intro = intro || cfg.intro || '';
      this.onClose = onClose;
      this.items = [];
      this.people = [];
      this.seq = 0;
      this.quote = null;
      this.ddp = {};
      this.loading = false;
      this.error = '';
      this.timer = null;
      this.reqId = 0;
      el.addEventListener('input', (e) => this.onInput(e));
      el.addEventListener('change', (e) => this.onChange(e));
      el.addEventListener('click', (e) => this.onClick(e));
    }

    newPerson() { return { id: `r${++this.seq}`, address: blankAddress(), alloc: {}, open: true }; }

    async load() {
      this.el.innerHTML = `<div class="sms-loading">Loading your bag…</div>`;
      const cart = await fetch(`${root}/cart.js`, { headers: { Accept: 'application/json' } }).then((r) => r.json());
      const merged = {};
      for (const l of cart.items) {
        if (!l.requires_shipping) continue;
        const id = String(l.variant_id);
        if (!merged[id]) merged[id] = { variantId: id, title: l.product_title, variant: l.variant_title || '', image: l.image || '', quantity: 0 };
        merged[id].quantity += l.quantity;
      }
      const prev = this.items;
      this.items = Object.values(merged);
      const same = prev.length === this.items.length && this.items.every((it) => prev.find((p) => p.variantId === it.variantId && p.quantity === it.quantity));
      if (!same || !this.people.length) {
        if (!this.people.length) this.people = [this.newPerson(), this.newPerson()];
        for (const p of this.people) p.alloc = {};
        for (const it of this.items) this.people[0].alloc[it.variantId] = it.quantity;
        this.quote = null;
      }
      this.render();
    }

    assigned(v) { return this.people.reduce((s, p) => s + (p.alloc[v] || 0), 0); }
    left() { return this.items.reduce((s, it) => s + it.quantity - this.assigned(it.variantId), 0); }
    count(p) { return Object.values(p.alloc).reduce((s, n) => s + n, 0); }
    used() { return this.people.filter((p) => this.count(p) > 0); }
    totalPieces() { return this.items.reduce((s, it) => s + it.quantity, 0); }
    addressDone(a) { return !!(a.name.trim() && a.address1.trim() && a.city.trim() && a.countryCode && a.phone.trim()); }

    // What still blocks checkout, in plain words. Empty when ready.
    todo() {
      const left = this.left();
      if (left > 0) return `${left} piece${left > 1 ? 's' : ''} still to give to someone`;
      const used = this.used();
      if (used.length < 2) return 'Give pieces to at least two people';
      const missing = used.find((p) => !this.addressDone(p.address));
      if (missing) return `Add ${missing.address.name.trim() ? esc(missing.address.name.trim()) + "'s" : `person ${this.people.indexOf(missing) + 1}'s`} full address and phone`;
      return '';
    }

    personLabel(p, i) { return p.address.name.trim() || `Person ${i + 1}`; }

    field(p, key, label, opts = {}) {
      return `<label class="sms-field${opts.half ? ' sms-field--half' : ''}">
        <span>${label}${opts.optional ? ' <em>optional</em>' : ''}</span>
        <input data-key="${key}" value="${esc(p.address[key])}" autocomplete="${opts.ac || 'off'}"${opts.type ? ` type="${opts.type}" inputmode="${opts.type}"` : ''}>
      </label>`;
    }

    personHtml(p, i) {
      const q = this.quote?.quotes.find((x) => x.id === p.id);
      const pieces = this.count(p);
      const done = this.addressDone(p.address);
      return `
      <section class="sms-person${p.open ? ' is-open' : ''}" data-person="${p.id}">
        <header class="sms-person__head">
          <span class="sms-person__num" aria-hidden="true">${i + 1}</span>
          <input class="sms-person__name" data-key="name" value="${esc(p.address.name)}" placeholder="Person ${i + 1}, their full name" autocomplete="off" aria-label="Full name of person ${i + 1}">
          ${this.people.length > 2 ? `<button type="button" class="sms-icon" data-remove aria-label="Remove ${esc(this.personLabel(p, i))}">✕</button>` : ''}
        </header>

        <div class="sms-pieces">
          ${this.items.map((it) => {
            const n = p.alloc[it.variantId] || 0;
            const canAdd = n < it.quantity; // takes one from someone else when the bag is fully shared
            return `<div class="sms-piece${n ? ' is-on' : ''}">
              ${it.image ? `<img src="${esc(it.image)}${it.image.includes('?') ? '&' : '?'}width=120" alt="" width="48" height="48" loading="lazy">` : '<span class="sms-piece__ph"></span>'}
              <span class="sms-piece__text"><span>${esc(it.title)}</span>${it.variant ? `<small>${esc(it.variant)}</small>` : ''}</span>
              <span class="sms-stepper" role="group" aria-label="${esc(it.title)} for ${esc(this.personLabel(p, i))}">
                <button type="button" data-minus="${it.variantId}" ${n ? '' : 'disabled'} aria-label="One less">−</button>
                <output>${n}</output>
                <button type="button" data-plus="${it.variantId}" ${canAdd ? '' : 'disabled'} aria-label="One more">+</button>
              </span>
            </div>`;
          }).join('')}
        </div>

        ${pieces > 0 ? `
        <details class="sms-address" ${done && !p.open ? '' : 'open'}>
          <summary>${done ? `<span>${esc([p.address.address1, p.address.city, countries.find((c) => c.code === p.address.countryCode)?.name].filter(Boolean).join(', '))}</span><span class="sms-link">Edit</span>` : '<span>Their address</span>'}</summary>
          <div class="sms-fields">
            ${this.field(p, 'address1', 'Street and number', { ac: 'address-line1' })}
            ${this.field(p, 'address2', 'Apartment, floor', { optional: true, ac: 'address-line2' })}
            ${this.field(p, 'city', 'City', { half: true, ac: 'address-level2' })}
            ${this.field(p, 'zip', 'Postcode', { half: true, optional: true, ac: 'postal-code' })}
            <label class="sms-field sms-field--half"><span>Country</span>
              <select data-key="countryCode">
                <option value="">Choose</option>
                ${countries.map((c) => `<option value="${c.code}"${c.code === p.address.countryCode ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
              </select>
            </label>
            ${this.field(p, 'provinceCode', 'State', { half: true, optional: true })}
            ${this.field(p, 'phone', 'Phone, for the courier', { ac: 'tel', type: 'tel' })}
          </div>
        </details>` : `<p class="sms-hint">Tap + to give this person a piece.</p>`}

        ${q ? `
        <div class="sms-rate${q.free ? ' is-free' : ''}">
          <span>${esc(q.shipping.label)}</span>
          <strong>${q.free ? 'Free' : money(q.shipping.amount)}</strong>
        </div>
        ${q.ddp?.available ? `
        <label class="sms-ddp">
          <input type="checkbox" data-ddp="${q.id}" ${this.ddp[q.id] ? 'checked' : ''}>
          <span>Pay their duties and taxes now, so nothing is due on arrival</span>
          <strong>${money(q.ddp.amount)}</strong>
        </label>` : ''}` : ''}
      </section>`;
    }

    footerHtml() {
      const todo = this.todo();
      let total = 0;
      if (this.quote && !todo) {
        for (const q of this.quote.quotes) total += q.shipping.amount + (this.ddp[q.id] && q.ddp?.available ? q.ddp.amount : 0);
      }
      const people = this.used().length;
      let status;
      if (this.error) status = `<p class="sms-status is-error" role="alert">${esc(this.error)}</p>`;
      else if (todo) status = `<p class="sms-status">${todo}</p>`;
      else if (this.loading || !this.quote) status = `<p class="sms-status">Getting DHL prices…</p>`;
      else status = `<p class="sms-status sms-status--total"><span>Delivery to ${people} people</span><strong>${total ? money(total) : 'Free'}</strong></p>`;
      const ready = !todo && this.quote && !this.loading && !this.error;
      return `${status}
        <button type="button" class="sms-btn" data-checkout ${ready ? '' : 'disabled'}>Continue to payment</button>
        ${this.error ? '<button type="button" class="sms-link sms-retry" data-retry>Try again</button>' : ''}`;
    }

    render() {
      if (!this.items.length) {
        this.el.innerHTML = `
          ${this.headHtml()}
          <div class="sms-empty">
            <p>Your bag is empty.</p>
            <p>Add the pieces you want to send, then come back to choose who gets what.</p>
            <a class="sms-btn" href="${esc(cfg.shopUrl || '/collections/shop')}">Choose pieces</a>
          </div>`;
        return;
      }
      const focus = document.activeElement && this.el.contains(document.activeElement) ? { person: document.activeElement.closest('[data-person]')?.dataset.person, key: document.activeElement.dataset.key, pos: document.activeElement.selectionStart } : null;
      this.el.innerHTML = `
        ${this.headHtml()}
        <div class="sms-body">
          ${this.people.map((p, i) => this.personHtml(p, i)).join('')}
          ${this.people.length < MAX_PEOPLE ? '<button type="button" class="sms-add" data-add>+ Add another person</button>' : ''}
          <p class="sms-note">Pieces for the same person travel together in one parcel. Everyone gets their own DHL tracking.</p>
        </div>
        <div class="sms-foot" data-foot>${this.footerHtml()}</div>`;
      if (focus?.key) {
        const el = this.el.querySelector(`[data-person="${focus.person}"] [data-key="${focus.key}"]`);
        if (el) { el.focus(); try { el.setSelectionRange(focus.pos, focus.pos); } catch {} }
      }
    }

    headHtml() {
      return `<div class="sms-head">
        <div>
          <h2 class="sms-title">${esc(this.title)}</h2>
          ${this.intro ? `<p class="sms-intro">${esc(this.intro)}</p>` : ''}
        </div>
        ${this.inline ? '' : '<button type="button" class="sms-icon sms-close" data-close aria-label="Close">✕</button>'}
      </div>`;
    }

    refreshFoot() {
      const foot = this.el.querySelector('[data-foot]');
      if (foot) foot.innerHTML = this.footerHtml();
    }

    // Prices refresh by themselves once every piece has a person and every person an address.
    changed({ rerender = true } = {}) {
      this.quote = null;
      this.error = '';
      clearTimeout(this.timer);
      if (rerender) this.render(); else this.refreshFoot();
      if (!this.todo()) this.timer = setTimeout(() => this.fetchQuote(), 600);
    }

    payload() {
      return {
        currency: currency(), rate: rate(), email: cfg.email || '', ddp: this.ddp,
        recipients: this.used().map((p) => ({
          id: p.id, address: p.address,
          lines: Object.entries(p.alloc).filter(([, q]) => q > 0).map(([variantId, quantity]) => ({ variantId, quantity })),
        })),
      };
    }

    async post(path) {
      const res = await fetch(`${proxy}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(this.payload()) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) throw new Error(json.error || 'Something went wrong. Please try again.');
      return json;
    }

    async fetchQuote() {
      const id = ++this.reqId;
      this.loading = true;
      this.refreshFoot();
      try {
        const q = await this.post('quote');
        if (id !== this.reqId) return;
        this.quote = q;
        for (const k of Object.keys(this.ddp)) if (!q.quotes.find((x) => x.id === k && x.ddp?.available)) delete this.ddp[k];
      } catch (e) {
        if (id !== this.reqId) return;
        this.error = e.message;
      } finally {
        if (id === this.reqId) { this.loading = false; this.render(); }
      }
    }

    onInput(e) {
      const card = e.target.closest('[data-person]');
      const key = e.target.dataset.key;
      if (!card || !key) return;
      const p = this.people.find((x) => x.id === card.dataset.person);
      p.address[key] = e.target.value;
      if (key === 'name') {
        const s = card.querySelector('.sms-stepper');
        if (s) s.setAttribute('aria-label', e.target.value);
      }
      this.changed({ rerender: false });
    }

    onChange(e) {
      if (e.target.dataset.ddp) { this.ddp[e.target.dataset.ddp] = e.target.checked; this.refreshFoot(); return; }
      // Text fields already update on input; re-rendering on blur would steal focus from the next field.
      if (e.target.dataset.key && e.target.tagName === 'SELECT') {
        const card = e.target.closest('[data-person]');
        this.people.find((x) => x.id === card.dataset.person).address[e.target.dataset.key] = e.target.value;
        this.changed();
      }
    }

    onClick(e) {
      const b = e.target.closest('button');
      if (!b) return;
      const card = b.closest('[data-person]');
      const p = card && this.people.find((x) => x.id === card.dataset.person);
      if (b.dataset.plus) {
        p.alloc[b.dataset.plus] = (p.alloc[b.dataset.plus] || 0) + 1;
        // Take it from whoever else has the most of it, so the total always matches the bag.
        if (this.assigned(b.dataset.plus) > this.items.find((i) => i.variantId === b.dataset.plus).quantity) {
          const donor = this.people.filter((x) => x !== p && x.alloc[b.dataset.plus] > 0).sort((a, c) => c.alloc[b.dataset.plus] - a.alloc[b.dataset.plus])[0];
          if (donor) donor.alloc[b.dataset.plus] -= 1; else p.alloc[b.dataset.plus] -= 1;
        }
        this.changed();
      } else if (b.dataset.minus) {
        p.alloc[b.dataset.minus] -= 1;
        this.changed();
      } else if (b.hasAttribute('data-remove')) {
        const giveBack = this.people[0] === p ? this.people[1] : this.people[0];
        for (const [v, n] of Object.entries(p.alloc)) giveBack.alloc[v] = (giveBack.alloc[v] || 0) + n;
        this.people = this.people.filter((x) => x !== p);
        delete this.ddp[p.id];
        this.changed();
      } else if (b.hasAttribute('data-add')) {
        const np = this.newPerson();
        // Move one piece from the person holding the most, so the new card is useful straight away.
        const donor = [...this.people].sort((a, c) => this.count(c) - this.count(a))[0];
        if (donor && this.count(donor) > 1) {
          const v = Object.entries(donor.alloc).sort((a, c) => c[1] - a[1])[0][0];
          donor.alloc[v] -= 1; np.alloc[v] = 1;
        }
        this.people.push(np);
        this.changed();
        this.el.querySelector(`[data-person="${np.id}"] .sms-person__name`)?.focus();
      } else if (b.hasAttribute('data-retry')) {
        this.changed();
      } else if (b.hasAttribute('data-close')) {
        this.onClose?.();
      } else if (b.hasAttribute('data-checkout')) {
        this.checkout(b);
      }
    }

    async checkout(b) {
      b.disabled = true;
      b.textContent = 'Opening checkout…';
      try {
        const out = await this.post('checkout');
        if (out.url) window.location.href = out.url;
      } catch (e) {
        this.error = e.message;
        this.refreshFoot();
      }
    }
  }

  // ---------- Sheet (drawer, cart, product page) ----------
  let sheet = null;
  let sheetFlow = null;
  function ensureSheet() {
    if (sheet) return sheet;
    sheet = document.createElement('dialog');
    sheet.className = 'sms-sheet';
    sheet.setAttribute('aria-label', cfg.title || 'Send to several people');
    sheet.innerHTML = '<div class="sms-sheet__panel sms-flow"></div>';
    document.body.appendChild(sheet);
    sheetFlow = new GiftFlow(sheet.firstElementChild, { onClose: close });
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    sheet.addEventListener('close', () => {
      document.documentElement.classList.remove('sms-lock');
      resetChoices();
    });
    return sheet;
  }
  function close() { if (sheet?.open) sheet.close(); }
  async function open() {
    ensureSheet();
    // Close the theme's cart drawer so only one panel shows.
    document.querySelectorAll('cart-drawer[open], #cart-drawer[open]').forEach((d) => d.hide?.());
    if (!sheet.open) sheet.showModal();
    document.documentElement.classList.add('sms-lock');
    await sheetFlow.load();
  }

  // ---------- "One address / Several people" choice ----------
  // data-siluet-ship-choice="cart"    : picking Several opens the sheet right away.
  // data-siluet-ship-choice="product" : picking Several means the next Add to bag opens the sheet.
  let productWantsSheet = false;
  function resetChoices() {
    document.querySelectorAll('[data-siluet-ship-choice="cart"] input[value="one"]').forEach((i) => { i.checked = true; });
  }
  document.addEventListener('change', (e) => {
    const group = e.target.closest('[data-siluet-ship-choice]');
    if (!group || e.target.type !== 'radio') return;
    const several = e.target.value === 'several';
    if (group.dataset.siluetShipChoice === 'product') {
      productWantsSheet = several;
      group.classList.toggle('is-several', several);
    } else if (several) {
      open();
    }
  });
  document.addEventListener('variant:add', () => {
    if (productWantsSheet) setTimeout(open, 50);
  });
  // Old links like /cart#gifting or #send-to-several open the sheet too.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href$="#send-to-several"], [data-siluet-gifting-open]');
    if (!a) return;
    e.preventDefault();
    open();
  });

  // ---------- Inline (Gifting page) ----------
  function mountInline() {
    document.querySelectorAll('[data-siluet-ms-inline]:not([data-ready])').forEach((el) => {
      el.dataset.ready = '1';
      el.classList.add('sms-flow', 'sms-flow--inline');
      const flow = new GiftFlow(el, { inline: true, title: el.dataset.title, intro: el.dataset.intro });
      flow.load();
      document.addEventListener('cart:change', () => flow.load());
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountInline); else mountInline();
  document.addEventListener('shopify:section:load', mountInline);

  window.SiluetGifting = { open, close };
})();
