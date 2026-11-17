import type { WizardExperience } from "../components/offer-wizard";

/** Maps persisted experience rows to the wizard's editable shape. */
export function toWizardExperiences(
  entries: Array<{
    experience: WizardExperience["experience"];
    enabled: boolean;
    headline: string | null;
    body: string | null;
    ctaLabel: string | null;
  }>,
): WizardExperience[] {
  return entries.map((entry) => ({
    experience: entry.experience,
    enabled: entry.enabled,
    headline: entry.headline ?? "",
    body: entry.body ?? "",
    ctaLabel: entry.ctaLabel ?? "",
  }));
}
