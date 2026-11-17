import type {
  ConditionField,
  ConditionJoinOp,
  ConditionOperator,
  OfferCondition,
  Prisma,
} from "@prisma/client";
import db from "../db.server";
import { InvalidInputError, TenantResourceNotFoundError } from "../utils/errors";
import {
  CONDITION_LIMITS,
  normalizeCondition,
  validateConditionTree,
} from "../utils/condition-schema";
import type { ConditionGroupNode } from "../utils/condition-schema";

/**
 * Tenant-scoped data access for condition trees.
 *
 * Foreign keys cannot prove that a group, its rule, and its shop agree, so
 * every write verifies ownership inside the transaction that performs it.
 */

export type ConditionGroupInput = {
  joinOp?: ConditionJoinOp;
  position?: number;
  parentGroupId?: string | null;
};

export type ConditionInput = {
  field: ConditionField;
  operator: ConditionOperator;
  value: unknown;
  position?: number;
};

export type ConditionUpdateInput = {
  field?: ConditionField;
  operator?: ConditionOperator;
  value?: unknown;
  position?: number;
};

const groupInclude = {
  conditions: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.OfferConditionGroupInclude;

export type ConditionGroupWithConditions =
  Prisma.OfferConditionGroupGetPayload<{ include: typeof groupInclude }>;

export type ConditionTreeGroup = ConditionGroupWithConditions & {
  children: ConditionTreeGroup[];
};

type TransactionClient = Prisma.TransactionClient;

async function assertRuleOwned(
  tx: TransactionClient,
  shopId: string,
  ruleId: string,
): Promise<void> {
  const rule = await tx.recommendationRule.findFirst({
    where: { id: ruleId, shopId },
    select: { id: true },
  });
  if (!rule) {
    throw new TenantResourceNotFoundError("Recommendation rule", ruleId);
  }
}

async function findGroup(
  tx: TransactionClient,
  shopId: string,
  ruleId: string,
  groupId: string,
) {
  return tx.offerConditionGroup.findFirst({
    where: { id: groupId, shopId, ruleId },
  });
}

function assertJoinOp(value: ConditionJoinOp): void {
  if (value !== "AND" && value !== "OR") {
    throw new InvalidInputError("Condition groups use AND or OR");
  }
}

function assertPosition(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidInputError("Condition positions must be whole numbers");
  }
}

export async function listConditionGroups(
  shopId: string,
  ruleId: string,
): Promise<ConditionGroupWithConditions[]> {
  return db.offerConditionGroup.findMany({
    where: { shopId, ruleId },
    include: groupInclude,
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * Returns roots with nested children, each carrying its own conditions.
 * Rows from other shops or rules are never loaded.
 */
export async function getConditionTree(
  shopId: string,
  ruleId: string,
): Promise<ConditionTreeGroup[]> {
  const groups = await listConditionGroups(shopId, ruleId);
  const nodes = new Map<string, ConditionTreeGroup>(
    groups.map((group) => [group.id, { ...group, children: [] }]),
  );
  const roots: ConditionTreeGroup[] = [];

  for (const group of groups) {
    const node = nodes.get(group.id);
    if (!node) continue;
    if (group.parentGroupId) {
      nodes.get(group.parentGroupId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export async function createConditionGroup(
  shopId: string,
  ruleId: string,
  input: ConditionGroupInput = {},
): Promise<ConditionGroupWithConditions> {
  const joinOp = input.joinOp ?? "AND";
  assertJoinOp(joinOp);
  if (input.position !== undefined) assertPosition(input.position);

  return db.$transaction(async (tx) => {
    await assertRuleOwned(tx, shopId, ruleId);

    if (input.parentGroupId) {
      const parent = await findGroup(tx, shopId, ruleId, input.parentGroupId);
      if (!parent) {
        throw new TenantResourceNotFoundError(
          "Condition group",
          input.parentGroupId,
        );
      }
      if (parent.parentGroupId !== null) {
        throw new InvalidInputError(
          `Conditions support at most ${CONDITION_LIMITS.maxDepth} levels`,
        );
      }
    }

    const groupCount = await tx.offerConditionGroup.count({
      where: { shopId, ruleId },
    });
    if (groupCount >= CONDITION_LIMITS.maxGroups) {
      throw new InvalidInputError(
        `A rule can have at most ${CONDITION_LIMITS.maxGroups} condition groups`,
      );
    }

    return tx.offerConditionGroup.create({
      data: {
        shopId,
        ruleId,
        joinOp,
        position: input.position ?? 0,
        parentGroupId: input.parentGroupId ?? null,
      },
      include: groupInclude,
    });
  });
}

/** Groups cannot move between parents; there is no reparenting API in 1B. */
export async function updateConditionGroup(
  shopId: string,
  ruleId: string,
  groupId: string,
  input: Omit<ConditionGroupInput, "parentGroupId">,
): Promise<ConditionGroupWithConditions> {
  if (input.joinOp !== undefined) assertJoinOp(input.joinOp);
  if (input.position !== undefined) assertPosition(input.position);

  return db.$transaction(async (tx) => {
    const group = await findGroup(tx, shopId, ruleId, groupId);
    if (!group) {
      throw new TenantResourceNotFoundError("Condition group", groupId);
    }

    return tx.offerConditionGroup.update({
      where: { id: group.id },
      data: { joinOp: input.joinOp, position: input.position },
      include: groupInclude,
    });
  });
}

export async function deleteConditionGroup(
  shopId: string,
  ruleId: string,
  groupId: string,
): Promise<void> {
  const result = await db.offerConditionGroup.deleteMany({
    where: { id: groupId, shopId, ruleId },
  });
  if (result.count === 0) {
    throw new TenantResourceNotFoundError("Condition group", groupId);
  }
}

export async function createCondition(
  shopId: string,
  ruleId: string,
  groupId: string,
  input: ConditionInput,
): Promise<OfferCondition> {
  const normalized = normalizeCondition(input);
  if (input.position !== undefined) assertPosition(input.position);

  return db.$transaction(async (tx) => {
    await assertRuleOwned(tx, shopId, ruleId);
    const group = await findGroup(tx, shopId, ruleId, groupId);
    if (!group) {
      throw new TenantResourceNotFoundError("Condition group", groupId);
    }

    const conditionCount = await tx.offerCondition.count({
      where: { shopId, group: { shopId, ruleId } },
    });
    if (conditionCount >= CONDITION_LIMITS.maxConditions) {
      throw new InvalidInputError(
        `A rule can have at most ${CONDITION_LIMITS.maxConditions} conditions`,
      );
    }

    return tx.offerCondition.create({
      data: {
        shopId,
        groupId: group.id,
        field: normalized.field,
        operator: normalized.operator,
        valueJson: normalized.valueJson as Prisma.InputJsonValue,
        position: input.position ?? 0,
      },
    });
  });
}

export async function updateCondition(
  shopId: string,
  ruleId: string,
  conditionId: string,
  input: ConditionUpdateInput,
): Promise<OfferCondition> {
  if (input.position !== undefined) assertPosition(input.position);

  return db.$transaction(async (tx) => {
    const existing = await tx.offerCondition.findFirst({
      where: { id: conditionId, shopId, group: { shopId, ruleId } },
    });
    if (!existing) {
      throw new TenantResourceNotFoundError("Condition", conditionId);
    }

    const normalized = normalizeCondition({
      field: input.field ?? existing.field,
      operator: input.operator ?? existing.operator,
      value: input.value !== undefined ? input.value : existing.valueJson,
    });

    return tx.offerCondition.update({
      where: { id: existing.id },
      data: {
        field: normalized.field,
        operator: normalized.operator,
        valueJson: normalized.valueJson as Prisma.InputJsonValue,
        position: input.position,
      },
    });
  });
}

export async function deleteCondition(
  shopId: string,
  ruleId: string,
  conditionId: string,
): Promise<void> {
  const result = await db.offerCondition.deleteMany({
    where: { id: conditionId, shopId, group: { shopId, ruleId } },
  });
  if (result.count === 0) {
    throw new TenantResourceNotFoundError("Condition", conditionId);
  }
}

/**
 * Re-validates the stored tree before evaluation. Returning the evaluator shape
 * keeps validation and evaluation from drifting apart.
 */
export function toEvaluatorTree(
  roots: ConditionTreeGroup[],
): ConditionGroupNode[] {
  const toNode = (group: ConditionTreeGroup): ConditionGroupNode => ({
    joinOp: group.joinOp,
    conditions: group.conditions.map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      valueJson: condition.valueJson,
      position: condition.position,
    })),
    children: group.children.map(toNode),
  });

  const tree = roots.map(toNode);
  validateConditionTree(tree);
  return tree;
}
