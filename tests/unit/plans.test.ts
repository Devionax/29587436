import { describe, expect, it } from "vitest";
import {
  PLANS,
  planByHandle,
  planById,
  planSelectionUrl,
} from "../../app/utils/plans";

describe("plan catalog", () => {
  it("maps known handles and ids", () => {
    expect(planByHandle("free")?.id).toBe("FREE");
    expect(planByHandle("GROWTH")?.id).toBe("GROWTH");
    expect(planByHandle("pro")?.id).toBe("PRO");
    expect(planById("PRO")?.name).toBe("Pro");
  });

  it("returns null for unknown values", () => {
    expect(planByHandle(null)).toBeNull();
    expect(planByHandle("enterprise")).toBeNull();
    expect(planById("ENTERPRISE")).toBeNull();
  });

  it("tightens limits monotonically across tiers", () => {
    expect(PLANS.FREE.limits.maxRules).toBeLessThan(
      PLANS.GROWTH.limits.maxRules ?? Infinity,
    );
    expect(PLANS.GROWTH.limits.maxRules).toBeLessThan(
      PLANS.PRO.limits.maxRules ?? Infinity,
    );
    expect(PLANS.FREE.limits.analyticsWindowDays).toBeLessThan(
      PLANS.GROWTH.limits.analyticsWindowDays,
    );
    expect(PLANS.PRO.limits.maxRules).toBeNull();
  });

  it("builds the Shopify-hosted plan selection URL", () => {
    expect(planSelectionUrl("demo-store.myshopify.com", "smart-upsell")).toBe(
      "https://admin.shopify.com/store/demo-store/charges/smart-upsell/pricing_plans",
    );
    expect(planSelectionUrl("my shop.myshopify.com", "app handle")).toBe(
      "https://admin.shopify.com/store/my%20shop/charges/app%20handle/pricing_plans",
    );
  });
});
