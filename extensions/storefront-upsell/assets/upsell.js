/**
 * Storefront upsell widget.
 *
 * Renders offers requested from the app proxy, adds them to the existing
 * Shopify cart with the Cart AJAX API, and reports permitted analytics events.
 * All dynamic text is written with textContent; no HTML is injected.
 */
(function () {
  if (window.customElements && customElements.get("upsell-offers")) return;

  var OFFERS_ENDPOINT = "/apps/upsell/offers";
  var EVENTS_ENDPOINT = "/apps/upsell/events";
  var GID_VARIANT = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/;
  var MAX_CART_LINES = 50;
  var SESSION_STORAGE_KEY = "scu_session";
  // Variants with an add request in flight, so a double click cannot add twice.
  var adding = {};
  var instanceCount = 0;

  /**
   * Line item properties prefixed with an underscore are hidden from the buyer
   * at checkout but stay attached to the order, which is what order attribution
   * reads later. See the shopify.dev line_item object.
   */
  function attribution(offer, surface) {
    return {
      _scu_rule: String(offer.ruleId),
      _scu_offer: String(offer.offerId),
      _scu_surface: surface,
      _scu_session: sessionKey(),
    };
  }

  function sessionKey() {
    try {
      var existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (existing) return existing;
      var id =
        window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID()
          : "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, id);
      return id;
    } catch (error) {
      return "s-" + Date.now().toString(36);
    }
  }

  function postEvent(payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(EVENTS_ENDPOINT, body);
        return;
      }
      fetch(EVENTS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true,
      }).catch(function () {
        /* analytics must never break the storefront */
      });
    } catch (error) {
      /* ignored */
    }
  }

  function track(eventType, offer, surface) {
    var session = sessionKey();
    postEvent({
      eventType: eventType,
      surface: surface,
      ruleId: offer.ruleId,
      offerId: offer.offerId,
      offerProductGid: offer.productGid,
      offerVariantGid: offer.variantGid,
      sessionKey: session,
      dedupeKey:
        eventType === "ADD_SUCCESS" || eventType === "ADD_FAILURE"
          ? session + ":" + eventType + ":" + offer.variantGid + ":" + Date.now()
          : session + ":" + eventType + ":" + offer.variantGid,
    });
  }

  function formatPrice(amount, currency) {
    if (!amount || !currency) return null;
    var active = window.Shopify && window.Shopify.currency && window.Shopify.currency.active;
    // Snapshot amounts are in the shop currency. Do not relabel them for a buyer
    // using another presentment currency; omit the price instead.
    if (active && active !== currency) return null;
    var value = Number(amount);
    if (!isFinite(value)) return null;
    try {
      return new Intl.NumberFormat(document.documentElement.lang || undefined, {
        style: "currency",
        currency: currency,
      }).format(value);
    } catch (error) {
      return null;
    }
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function cartLines() {
    return fetch("/cart.js", { headers: { Accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) return [];
        return response.json();
      })
      .then(function (cart) {
        var items = cart && Array.isArray(cart.items) ? cart.items.slice(0, MAX_CART_LINES) : [];
        return items
          .map(function (item) {
            return {
              productGid: item.product_id
                ? "gid://shopify/Product/" + item.product_id
                : null,
              variantGid: item.variant_id
                ? "gid://shopify/ProductVariant/" + item.variant_id
                : null,
              quantity: item.quantity,
            };
          })
          .filter(function (line) {
            return line.productGid || line.variantGid;
          });
      })
      .catch(function () {
        return [];
      });
  }

  function buildCard(offer, surface, widget) {
    var card = element("li", "scu-upsell__card");

    if (offer.imageUrl) {
      var image = element("img", "scu-upsell__image");
      image.src = offer.imageUrl;
      image.alt = "";
      image.loading = "lazy";
      image.width = 72;
      image.height = 72;
      card.appendChild(image);
    }

    var body = element("div", "scu-upsell__body");
    body.appendChild(element("p", "scu-upsell__title", offer.productTitle));
    if (offer.variantTitle && offer.variantTitle !== "Default Title") {
      body.appendChild(element("p", "scu-upsell__variant", offer.variantTitle));
    }

    var price = formatPrice(offer.price, offer.currencyCode);
    if (price) {
      var priceLine = element("p", "scu-upsell__price", price);
      var compare = formatPrice(offer.compareAtPrice, offer.currencyCode);
      if (compare && Number(offer.compareAtPrice) > Number(offer.price)) {
        priceLine.appendChild(element("span", "scu-upsell__compare", " " + compare));
      }
      body.appendChild(priceLine);
    }

    var controls = element("div", "scu-upsell__controls");
    var quantityId = "scu-qty-" + (widget._instanceId || "0") + "-" + offer.offerId;
    var quantityLabel = element("label", "scu-upsell__qty-label", "Quantity");
    quantityLabel.setAttribute("for", quantityId);
    var quantity = element("input", "scu-upsell__qty");
    quantity.type = "number";
    quantity.id = quantityId;
    quantity.min = String(offer.minQuantity);
    quantity.max = String(offer.maxQuantity);
    quantity.step = "1";
    quantity.value = String(offer.defaultQuantity);
    quantity.inputMode = "numeric";

    var addButton = element("button", "scu-upsell__add", "Add");
    addButton.type = "button";

    var status = element("p", "scu-upsell__status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    addButton.addEventListener("click", function () {
      if (adding[offer.variantGid]) return;

      var match = GID_VARIANT.exec(offer.variantGid || "");
      if (!match) {
        status.textContent = "This option is unavailable.";
        addButton.disabled = true;
        return;
      }

      var requested = parseInt(quantity.value, 10);
      if (!isFinite(requested)) requested = offer.defaultQuantity;
      var clamped = Math.min(Math.max(requested, offer.minQuantity), offer.maxQuantity);
      quantity.value = String(clamped);

      adding[offer.variantGid] = true;
      addButton.disabled = true;
      status.textContent = "Adding…";

      var properties = attribution(offer, surface);
      track("ADD_ATTEMPT", offer, surface);

      fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          items: [{ id: Number(match[1]), quantity: clamped, properties: properties }],
        }),
      })
        .catch(function () {
          throw new Error("Could not reach the cart. Check your connection and try again.");
        })
        .then(function (response) {
          if (response.ok) return response.json();
          return response.json().then(
            function (payload) {
              throw new Error(payload && payload.description ? payload.description : "Cart rejected the change.");
            },
            function () {
              throw new Error("Cart rejected the change.");
            },
          );
        })
        .then(function () {
          delete adding[offer.variantGid];
          track("ADD_SUCCESS", offer, surface);
          status.textContent = "Added to cart.";
          addButton.textContent = "Added";
          quantity.disabled = true;
          widget.dispatchEvent(
            new CustomEvent("upsell:added", {
              bubbles: true,
              detail: {
                variantGid: offer.variantGid,
                quantity: clamped,
                ruleId: offer.ruleId,
                offerId: offer.offerId,
                surface: surface,
              },
            }),
          );

          if (surface === "cart") {
            // Theme cart totals and line markup are owned by the theme, so let it
            // reload with the confirmed cart rather than patching its DOM.
            window.setTimeout(function () {
              window.location.reload();
            }, 700);
          } else {
            var cartLink = element("a", "scu-upsell__cart-link", "View cart");
            cartLink.href = "/cart";
            status.appendChild(document.createTextNode(" "));
            status.appendChild(cartLink);
          }
        })
        .catch(function (error) {
          delete adding[offer.variantGid];
          addButton.disabled = false;
          track("ADD_FAILURE", offer, surface);
          status.textContent =
            error && error.message ? error.message : "Could not add this item. Try again.";
        });
    });

    controls.appendChild(quantityLabel);
    controls.appendChild(quantity);
    controls.appendChild(addButton);
    body.appendChild(controls);
    body.appendChild(status);
    card.appendChild(body);

    return card;
  }

  function render(widget, payload, surface) {
    if (
      !payload ||
      payload.enabled === false ||
      !Array.isArray(payload.offers) ||
      payload.offers.length === 0
    ) {
      widget.textContent = "";
      widget.hidden = true;
      return;
    }

    var region = element("section", "scu-upsell");
    region.setAttribute("aria-label", payload.heading || "Recommendations");

    region.appendChild(element("h2", "scu-upsell__heading", payload.heading || "You may also like"));

    var list = element("ul", "scu-upsell__list");
    payload.offers.forEach(function (offer) {
      list.appendChild(buildCard(offer, surface, widget));
    });
    region.appendChild(list);

    widget.textContent = "";
    widget.appendChild(region);
    widget.hidden = false;

    payload.offers.forEach(function (offer) {
      track("IMPRESSION", offer, surface);
    });
  }

  class UpsellOffers extends HTMLElement {
    connectedCallback() {
      if (this.dataset.rendered === "true") return;
      this.dataset.rendered = "true";
      this._instanceId = String(++instanceCount);

      const self = this;
      const surface = this.dataset.surface === "cart" ? "cart" : "product";
      const endpoint = this.dataset.endpoint || OFFERS_ENDPOINT;
      const productGid = this.dataset.productGid || "";
      const productVariantGid = this.dataset.productVariantGid || "";

      if (window.Shopify && window.Shopify.designMode) {
        const placeholder = element(
          "p",
          "scu-upsell__placeholder",
          "Upsell offers appear here on the live storefront.",
        );
        this.textContent = "";
        this.appendChild(placeholder);
        this.hidden = false;
        return;
      }

      cartLines()
        .then(function (lines) {
          if (surface === "product" && productGid) {
            const known = lines.some(function (line) {
              return productVariantGid && line.variantGid === productVariantGid;
            });
            if (!known) {
              lines.push({
                productGid: productGid,
                variantGid: GID_VARIANT.test(productVariantGid) ? productVariantGid : null,
                quantity: 1,
              });
            }
          }

          const params = new URLSearchParams();
          params.set("surface", surface);
          if (productGid) params.set("product", productGid);
          params.set("cart", JSON.stringify(lines.slice(0, MAX_CART_LINES)));

          return fetch(endpoint + "?" + params.toString(), {
            headers: { Accept: "application/json" },
          });
        })
        .then(function (response) {
          if (!response.ok) return null;
          return response.json();
        })
        .then(function (payload) {
          if (!payload) return;
          if (self.dataset.heading) {
            payload.heading = self.dataset.heading;
          }
          render(self, payload, surface);
        })
        .catch(function () {
          self.hidden = true;
        });
    }
  }

  customElements.define("upsell-offers", UpsellOffers);
})();
