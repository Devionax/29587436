import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeAppProxySignature,
  proxiedShopDomain,
  verifyAppProxyRequest,
} from "../../app/utils/app-proxy.server";

const SECRET = "test-app-secret";

function sign(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  search.set("signature", computeAppProxySignature(search, SECRET));
  return search.toString();
}

describe("app proxy signatures", () => {
  it("matches an independently computed HMAC over sorted key=value pairs", () => {
    const params = new URLSearchParams({
      shop: "demo.myshopify.com",
      timestamp: "1700000000",
      surface: "product",
    });

    const expected = crypto
      .createHmac("sha256", SECRET)
      .update("shop=demo.myshopify.comsurface=producttimestamp=1700000000")
      .digest("hex");

    expect(computeAppProxySignature(params, SECRET)).toBe(expected);
  });

  it("accepts a correctly signed request", () => {
    const url = new URL(`https://app.test/proxy/offers?${sign({ shop: "a.myshopify.com" })}`);
    expect(verifyAppProxyRequest(url, SECRET)).toBe(true);
  });

  it("rejects a tampered parameter", () => {
    const query = new URLSearchParams(sign({ shop: "a.myshopify.com", surface: "cart" }));
    query.set("surface", "product");

    expect(verifyAppProxyRequest(new URL(`https://app.test?${query}`), SECRET)).toBe(false);
  });

  it("rejects a missing signature", () => {
    const url = new URL("https://app.test/proxy/offers?shop=a.myshopify.com");
    expect(verifyAppProxyRequest(url, SECRET)).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    const query = new URLSearchParams({
      shop: "a.myshopify.com",
      signature: computeAppProxySignature(
        new URLSearchParams({ shop: "a.myshopify.com" }),
        "other-secret",
      ),
    });

    expect(verifyAppProxyRequest(new URL(`https://app.test?${query}`), SECRET)).toBe(false);
  });

  it("joins repeated parameters with commas like Shopify", () => {
    const params = new URLSearchParams();
    params.append("ids[]", "1");
    params.append("ids[]", "2");
    params.set("shop", "a.myshopify.com");

    const expected = crypto
      .createHmac("sha256", SECRET)
      .update("ids[]=1,2shop=a.myshopify.com")
      .digest("hex");

    expect(computeAppProxySignature(params, SECRET)).toBe(expected);
  });

  it("normalizes the proxied shop domain", () => {
    const url = new URL("https://app.test?shop=Demo.MyShopify.com");
    expect(proxiedShopDomain(url)).toBe("demo.myshopify.com");
    expect(proxiedShopDomain(new URL("https://app.test"))).toBeNull();
  });
});
