import { describe, expect, it } from "vitest";
import { recommendOffers } from "../../app/services/recommendation-engine";
import type {
  CartLine,
  EngineOffer,
  EngineProduct,
  EngineRule,
  EngineTrigger,
} from "../../app/services/recommendation-engine";

const P_TRIGGER = "gid://shopify/Product/1";
const P_OFFER = "gid://shopify/Product/2";
const P_EXTRA = "gid://shopify/Product/3";

const V_TRIGGER = "gid://shopify/ProductVariant/11";
const V_OFFER = "gid://shopify/ProductVariant/21";
const V_EXTRA = "gid://shopify/ProductVariant/31";

function offer(overrides: Partial<EngineOffer> = {}): EngineOffer {
  return {
    id: "offer-1",
    productGid: P_OFFER,
    variantGid: V_OFFER,
    defaultQuantity: 1,
    minQuantity: 1,
    maxQuantity: 5,
    position: 0,
    active: true,
    ...overrides,
  };
}

function rule(overrides: Partial<EngineRule> = {}): EngineRule {
  return {
    id: "rule-1",
    name: "Pairs well",
    status: "ACTIVE",
    priority: 10,
    matchMode: "ANY",
    heading: "Pairs well with",
    maxOffers: null,
    showOnProductPage: true,
    showOnCartPage: true,
    triggers: [{ productGid: P_TRIGGER, variantGid: "" }],
    offers: [offer()],
    ...overrides,
  };
}

function product(overrides: Partial<EngineProduct> = {}): EngineProduct {
  return {
    productGid: P_OFFER,
    title: "Shoe care kit",
    handle: "shoe-care-kit",
    imageUrl: "https://cdn.example.com/kit.png",
    status: "ACTIVE",
    availableForSale: true,
    currencyCode: "USD",
    variants: [
      {
        variantGid: V_OFFER,
        title: "Default",
        price: "19.00",
        compareAtPrice: null,
        availableForSale: true,
      },
    ],
    ...overrides,
  };
}

function extraProduct(): EngineProduct {
  return product({
    productGid: P_EXTRA,
    title: "Extra product",
    handle: "extra-product",
    variants: [
      {
        variantGid: V_EXTRA,
        title: "Default",
        price: "9.00",
        compareAtPrice: null,
        availableForSale: true,
      },
    ],
  });
}

function extraOffer(overrides: Partial<EngineOffer> = {}): EngineOffer {
  return offer({ id: "offer-extra", productGid: P_EXTRA, variantGid: V_EXTRA, ...overrides });
}

function cart(overrides: Partial<CartLine> = {}): CartLine[] {
  return [{ productGid: P_TRIGGER, variantGid: V_TRIGGER, quantity: 1, ...overrides }];
}

function run(options: {
  rules?: EngineRule[];
  products?: EngineProduct[];
  cart?: CartLine[];
  surface?: "PRODUCT_PAGE" | "CART_PAGE";
  limit?: number;
  defaultHeading?: string | null;
  hasCartItems?: boolean;
}) {
  return recommendOffers({
    rules: options.rules ?? [rule()],
    products: options.products ?? [product()],
    cart: options.cart ?? cart(),
    surface: options.surface ?? "PRODUCT_PAGE",
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.defaultHeading === undefined
      ? {}
      : { defaultHeading: options.defaultHeading }),
    ...(options.hasCartItems === undefined
      ? {}
      : { hasCartItems: options.hasCartItems }),
  });
}

describe("recommendation engine", () => {
  it("returns the offer for a matching cart line", () => {
    const result = run({});

    expect(result.offers).toHaveLength(1);
    expect(result.heading).toBe("Pairs well with");
    expect(result.offers[0]).toMatchObject({
      ruleId: "rule-1",
      variantGid: V_OFFER,
      productTitle: "Shoe care kit",
      price: "19.00",
    });
  });

  it("returns nothing when the cart does not include a trigger", () => {
    const result = run({ cart: [{ productGid: P_EXTRA, variantGid: V_EXTRA, quantity: 1 }] });

    expect(result.offers).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe("NO_TRIGGER_MATCH");
  });

  it("matches a variant-specific trigger only for that variant", () => {
    const rules = [rule({ triggers: [{ productGid: P_TRIGGER, variantGid: V_TRIGGER }] })];

    expect(run({ rules, cart: cart() }).offers).toHaveLength(1);
    expect(
      run({ rules, cart: cart({ variantGid: "gid://shopify/ProductVariant/99" }) }).offers,
    ).toHaveLength(0);
  });

  it("requires every trigger in ALL mode", () => {
    const triggers: EngineTrigger[] = [
      { productGid: P_TRIGGER, variantGid: "" },
      { productGid: P_EXTRA, variantGid: "" },
    ];
    const rules = [rule({ matchMode: "ALL", triggers })];

    expect(run({ rules, cart: cart() }).offers).toHaveLength(0);

    const both = [...cart(), { productGid: P_EXTRA, variantGid: V_EXTRA, quantity: 1 }];
    expect(run({ rules, cart: both }).offers).toHaveLength(1);
  });

  it("skips inactive rules and rules disabled for the surface", () => {
    expect(run({ rules: [rule({ status: "PAUSED" })] }).excluded[0].reason).toBe(
      "RULE_INACTIVE",
    );
    expect(
      run({ rules: [rule({ showOnCartPage: false })], surface: "CART_PAGE" }).excluded[0]
        .reason,
    ).toBe("SURFACE_DISABLED");
  });

  it("orders rules by priority and falls back to rule id", () => {
    const rules = [
      rule({ id: "rule-b", priority: 20 }),
      rule({ id: "rule-a", priority: 5, offers: [extraOffer()] }),
    ];

    const result = run({ rules, products: [product(), extraProduct()] });

    expect(result.offers.map((item) => item.ruleId)).toEqual(["rule-a", "rule-b"]);
  });

  it("orders offers by position inside a rule", () => {
    const rules = [
      rule({
        offers: [
          extraOffer({ id: "o2", position: 2 }),
          offer({ id: "o1", position: 1 }),
        ],
      }),
    ];

    expect(run({ rules, products: [product(), extraProduct()] }).offers.map((item) => item.offerId)).toEqual(
      ["o1", "o2"],
    );
  });

  it("drops duplicate offer variants across rules", () => {
    const rules = [rule({ id: "rule-a", priority: 1 }), rule({ id: "rule-b", priority: 2 })];
    const result = run({ rules });

    expect(result.offers).toHaveLength(1);
    expect(result.excluded.some((item) => item.reason === "DUPLICATE_OFFER")).toBe(true);
  });

  it("filters unavailable and already-in-cart offers", () => {
    const unavailable = product({
      variants: [
        { variantGid: V_OFFER, title: "Default", price: "19.00", compareAtPrice: null, availableForSale: false },
      ],
    });
    expect(run({ products: [unavailable] }).excluded[0].reason).toBe("OFFER_UNAVAILABLE");

    const inCart = [...cart(), { productGid: P_OFFER, variantGid: V_OFFER, quantity: 1 }];
    expect(run({ cart: inCart }).excluded[0].reason).toBe("OFFER_ALREADY_IN_CART");
  });

  it("filters inactive offers, missing snapshots and non-active products", () => {
    expect(run({ rules: [rule({ offers: [offer({ active: false })] })] }).excluded[0].reason).toBe(
      "OFFER_INACTIVE",
    );

    expect(
      run({
        rules: [rule({ offers: [offer({ productGid: P_EXTRA, variantGid: V_EXTRA })] })],
      }).excluded[0].reason,
    ).toBe("OFFER_PRODUCT_MISSING");

    const draftProduct = product({ status: "DRAFT" });
    expect(run({ products: [draftProduct] }).excluded[0].reason).toBe(
      "OFFER_PRODUCT_NOT_ACTIVE",
    );

    const missingVariant = product({ variants: [] });
    expect(run({ products: [missingVariant] }).excluded[0].reason).toBe(
      "OFFER_VARIANT_MISSING",
    );
  });

  it("applies the per-rule offer cap and the global limit", () => {
    const twoOffers = rule({
      maxOffers: 1,
      offers: [offer({ id: "o1" }), extraOffer({ id: "o2", position: 1 })],
    });
    const capped = run({ rules: [twoOffers], products: [product(), extraProduct()] });

    expect(capped.offers).toHaveLength(1);
    expect(capped.excluded.some((item) => item.reason === "OVER_OFFER_CAP")).toBe(true);

    const global = run({
      limit: 1,
      rules: [rule({ id: "a" }), rule({ id: "b", priority: 11, offers: [extraOffer()] })],
      products: [product(), extraProduct()],
    });
    expect(global.offers).toHaveLength(1);
  });

  it("uses the shop fallback heading when a rule has none", () => {
    expect(run({ rules: [rule({ heading: null })] }).heading).toBe("You may also like");
    expect(
      run({ rules: [rule({ heading: null })], defaultHeading: "Complete your setup" }).heading,
    ).toBe("Complete your setup");
  });

  it("ignores zero-quantity cart lines", () => {
    expect(run({ cart: cart({ quantity: 0 }) }).offers).toHaveLength(0);
  });
});

describe("manual audience", () => {
  function manualRule(overrides: Partial<EngineRule> = {}): EngineRule {
    return rule({ manualAudience: true, triggers: [], ...overrides });
  }

  it("needs a non-empty real cart", () => {
    const empty = run({
      rules: [manualRule()],
      cart: [],
      surface: "CART_PAGE",
      hasCartItems: false,
    });
    expect(empty.offers).toHaveLength(0);
    expect(empty.excluded[0]?.reason).toBe("NO_TRIGGERS");

    const filled = run({
      rules: [manualRule()],
      cart: cart(),
      surface: "CART_PAGE",
      hasCartItems: true,
    });
    expect(filled.offers).toHaveLength(1);
  });

  it("stays hidden when only the viewed product is in the evaluation cart", () => {
    const result = run({
      rules: [manualRule()],
      cart: cart(),
      surface: "PRODUCT_PAGE",
      hasCartItems: false,
    });

    expect(result.offers).toHaveLength(0);
  });

  it("respects the placement switches", () => {
    const result = run({
      rules: [manualRule({ showOnCartPage: false })],
      cart: cart(),
      surface: "CART_PAGE",
      hasCartItems: true,
    });

    expect(result.offers).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe("SURFACE_DISABLED");
  });

  it("still requires a trigger match when triggers exist", () => {
    const result = run({
      rules: [rule({ triggers: [{ productGid: P_EXTRA, variantGid: "" }] })],
      cart: cart(),
      hasCartItems: true,
    });

    expect(result.offers).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe("NO_TRIGGER_MATCH");
  });
});
