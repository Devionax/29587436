import type { ReactNode } from "react";
import type { Experience, OfferSource, RuleStatus } from "@prisma/client";

/** Small shared building blocks so metric tiles and empty states stay consistent. */

export function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string | null;
}) {
  return (
    <s-box padding="base" background="base" border="base" borderRadius="large-100">
      <s-stack direction="block" gap="small">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {detail ? <s-text color="subdued">{detail}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return (
    <s-grid
      gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))"
      gap="base"
    >
      {children}
    </s-grid>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <s-section accessibilityLabel={title}>
      <s-box padding="large" background="subdued" borderRadius="large-100">
        <s-stack direction="block" gap="base" alignItems="center">
          <s-heading>{title}</s-heading>
          <s-paragraph color="subdued">{children}</s-paragraph>
          {action}
        </s-stack>
      </s-box>
    </s-section>
  );
}

const STATUS_TONE: Record<RuleStatus, "success" | "warning" | "neutral" | "critical"> = {
  ACTIVE: "success",
  PAUSED: "warning",
  DRAFT: "neutral",
  ARCHIVED: "critical",
};

export function StatusBadge({ status }: { status: RuleStatus }) {
  return <s-badge tone={STATUS_TONE[status]}>{status.toLowerCase()}</s-badge>;
}

export const SOURCE_LABELS: Record<OfferSource, string> = {
  MANUAL: "Manual",
  RECENTLY_REMOVED: "Recently removed",
  REPEATED_ACTIVITY: "Repeated activity",
};

export function sourceLabel(source: OfferSource): string {
  return SOURCE_LABELS[source] ?? source;
}

export const EXPERIENCE_LABELS: Record<Experience, string> = {
  PRE_PURCHASE: "Pre-purchase",
  POST_PURCHASE: "Post-purchase",
};

/** Enabled experiences only: a disabled row is not delivered. */
export function experiencesLabel(experiences: Experience[]): string {
  if (experiences.length === 0) return "Not delivered";
  return experiences.map((experience) => EXPERIENCE_LABELS[experience]).join(" · ");
}

export function formatNumber(value: number): string {
  return value.toLocaleString();
}

export function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${Math.round((numerator / denominator) * 1000) / 10}%`;
}

export function formatMoney(amount: string | null, currency: string | null): string {
  if (!amount) return "—";
  if (!currency) return amount;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}
