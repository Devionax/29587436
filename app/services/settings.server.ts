import db from "../db.server";
import { InvalidInputError } from "../utils/errors";

/**
 * Shop-level settings. Every function is scoped by the authenticated shopId;
 * only the writable fields below are ever copied from input.
 *
 * `enabled` gates checkout delivery. The storefront placement switches are kept
 * for the legacy theme blocks but default to off: the post-purchase page is the
 * only placement this release delivers.
 */

export type SettingsInput = {
  enabled: boolean;
  defaultHeading: string;
  maxOffers: number;
  productPageEnabled: boolean;
  cartPageEnabled: boolean;
};

export const DEFAULT_SETTINGS: SettingsInput = {
  enabled: false,
  defaultHeading: "You may also like",
  maxOffers: 3,
  productPageEnabled: false,
  cartPageEnabled: false,
};

export async function getSettings(shopId: string): Promise<SettingsInput> {
  const settings = await db.shopSettings.findUnique({ where: { shopId } });

  if (!settings) {
    return DEFAULT_SETTINGS;
  }

  return {
    enabled: settings.enabled,
    defaultHeading: settings.defaultHeading,
    maxOffers: settings.maxOffers,
    productPageEnabled: settings.productPageEnabled,
    cartPageEnabled: settings.cartPageEnabled,
  };
}

export function validateSettings(input: SettingsInput): SettingsInput {
  const heading = input.defaultHeading.trim();
  if (heading.length > 80) {
    throw new InvalidInputError("Keep the display heading under 80 characters.");
  }
  if (!Number.isInteger(input.maxOffers) || input.maxOffers < 1 || input.maxOffers > 10) {
    throw new InvalidInputError("Maximum offers must be a whole number from 1 to 10.");
  }

  return {
    enabled: input.enabled,
    defaultHeading: heading || DEFAULT_SETTINGS.defaultHeading,
    maxOffers: input.maxOffers,
    productPageEnabled: input.productPageEnabled,
    cartPageEnabled: input.cartPageEnabled,
  };
}

export async function updateSettings(
  shopId: string,
  input: SettingsInput,
): Promise<SettingsInput> {
  const clean = validateSettings(input);

  const settings = await db.shopSettings.upsert({
    where: { shopId },
    create: { shopId, ...clean },
    update: clean,
  });

  return {
    enabled: settings.enabled,
    defaultHeading: settings.defaultHeading,
    maxOffers: settings.maxOffers,
    productPageEnabled: settings.productPageEnabled,
    cartPageEnabled: settings.cartPageEnabled,
  };
}
