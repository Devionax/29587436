import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
});

export async function createShop(
  suffix: string,
  options: { plan?: "FREE" | "GROWTH" | "PRO" } = {},
) {
  const id = `${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const plan = options.plan ?? "PRO";

  const subscription =
    plan === "FREE"
      ? undefined
      : {
          create: {
            planName: plan,
            status: "ACTIVE" as const,
            lastVerifiedAt: new Date(),
          },
        };

  return prisma.shop.create({
    data: {
      shopDomain: `${id}.myshopify.com`,
      name: `Test shop ${suffix}`,
      installationStatus: "INSTALLED",
      installedAt: new Date(),
      settings: { create: {} },
      ...(subscription ? { subscription } : {}),
    },
  });
}

export function ruleInput(name: string) {
  return {
    name,
    status: "ACTIVE" as const,
    priority: 10,
    matchMode: "ANY" as const,
    heading: "Pairs well with",
    triggers: [{ productGid: "gid://shopify/Product/1" }],
    offers: [
      {
        productGid: "gid://shopify/Product/2",
        variantGid: "gid://shopify/ProductVariant/22",
      },
    ],
  };
}
