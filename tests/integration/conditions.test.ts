import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../app/db.server";
import {
  createCondition,
  createConditionGroup,
  deleteCondition,
  deleteConditionGroup,
  getConditionTree,
  listConditionGroups,
  updateCondition,
  updateConditionGroup,
} from "../../app/services/conditions.server";
import { createRule, deleteRule } from "../../app/services/rules.server";
import {
  InvalidInputError,
  TenantResourceNotFoundError,
} from "../../app/utils/errors";
import { createShop, prisma, ruleInput } from "../helpers/db";

describe("condition trees", () => {
  let shopA: Awaited<ReturnType<typeof createShop>>;
  let shopB: Awaited<ReturnType<typeof createShop>>;
  let ruleA: Awaited<ReturnType<typeof createRule>>;
  let ruleB: Awaited<ReturnType<typeof createRule>>;

  beforeAll(async () => {
    shopA = await createShop("conditions-a");
    shopB = await createShop("conditions-b");
    ruleA = await createRule(shopA.id, ruleInput("Conditions A"));
    ruleB = await createRule(shopB.id, ruleInput("Conditions B"));
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({
      where: { id: { in: [shopA.id, shopB.id] } },
    });
    await prisma.$disconnect();
    await db.$disconnect();
  });

  it("stamps the authenticated shop on groups and conditions", async () => {
    const rule = await createRule(shopA.id, ruleInput("Stamped rule"));
    const root = await createConditionGroup(shopA.id, rule.id);
    const condition = await createCondition(shopA.id, rule.id, root.id, {
      field: "CART_SUBTOTAL",
      operator: "GTE",
      value: 25,
    });

    expect(root.shopId).toBe(shopA.id);
    expect(root.ruleId).toBe(rule.id);
    expect(condition.shopId).toBe(shopA.id);
    expect(condition.groupId).toBe(root.id);
  });

  it("does not create a group on another shop's rule", async () => {
    await expect(
      createConditionGroup(shopA.id, ruleB.id),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);
    expect(await listConditionGroups(shopB.id, ruleB.id)).toEqual([]);
  });

  it("rejects a parent from another rule or another shop", async () => {
    const rule = await createRule(shopA.id, ruleInput("Parent rule"));
    const siblingRule = await createRule(shopA.id, ruleInput("Sibling rule"));
    const parent = await createConditionGroup(shopA.id, rule.id);
    const foreignParent = await createConditionGroup(shopB.id, ruleB.id);

    await expect(
      createConditionGroup(shopA.id, siblingRule.id, {
        parentGroupId: parent.id,
      }),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);

    await expect(
      createConditionGroup(shopA.id, rule.id, {
        parentGroupId: foreignParent.id,
      }),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);
  });

  it("rejects a third level under a nested group", async () => {
    const rule = await createRule(shopA.id, ruleInput("Depth rule"));
    const root = await createConditionGroup(shopA.id, rule.id);
    const child = await createConditionGroup(shopA.id, rule.id, {
      parentGroupId: root.id,
    });

    await expect(
      createConditionGroup(shopA.id, rule.id, { parentGroupId: child.id }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("nests children and orders conditions for reads", async () => {
    const rule = await createRule(shopA.id, ruleInput("Ordering rule"));
    const root = await createConditionGroup(shopA.id, rule.id, {
      position: 1,
    });
    await createConditionGroup(shopA.id, rule.id, {
      parentGroupId: root.id,
      position: 2,
    });
    await createCondition(shopA.id, rule.id, root.id, {
      field: "SHIPPING_COUNTRY",
      operator: "EQ",
      value: "us",
      position: 2,
    });
    await createCondition(shopA.id, rule.id, root.id, {
      field: "CART_LINE_COUNT",
      operator: "GTE",
      value: 1,
      position: 1,
    });

    const [treeRoot] = await getConditionTree(shopA.id, rule.id);
    expect(treeRoot.id).toBe(root.id);
    expect(treeRoot.children).toHaveLength(1);
    expect(treeRoot.conditions.map((entry) => entry.position)).toEqual([1, 2]);
    expect(treeRoot.conditions[0].valueJson).toBe(1);
    expect(treeRoot.conditions[1].valueJson).toBe("US");
  });

  it("validates values before writing anything", async () => {
    const rule = await createRule(shopA.id, ruleInput("Validation rule"));
    const root = await createConditionGroup(shopA.id, rule.id);

    await expect(
      createCondition(shopA.id, rule.id, root.id, {
        field: "SHIPPING_COUNTRY",
        operator: "EQ",
        value: "USA",
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    expect(
      await prisma.offerCondition.count({ where: { groupId: root.id } }),
    ).toBe(0);
  });

  it("merges partial condition updates with the stored value", async () => {
    const rule = await createRule(shopA.id, ruleInput("Update rule"));
    const root = await createConditionGroup(shopA.id, rule.id);
    const condition = await createCondition(shopA.id, rule.id, root.id, {
      field: "CART_SUBTOTAL",
      operator: "GTE",
      value: 10,
    });

    const updated = await updateCondition(shopA.id, rule.id, condition.id, {
      value: 20,
    });

    expect(updated.field).toBe("CART_SUBTOTAL");
    expect(updated.operator).toBe("GTE");
    expect(updated.valueJson).toBe(20);

    await expect(
      updateCondition(shopA.id, rule.id, condition.id, { value: -5 }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("does not read, update, or delete another shop's tree", async () => {
    const foreign = await createConditionGroup(shopB.id, ruleB.id);
    const foreignCondition = await createCondition(
      shopB.id,
      ruleB.id,
      foreign.id,
      {
        field: "ORDER_TOTAL",
        operator: "GT",
        value: 50,
      },
    );

    expect(await listConditionGroups(shopA.id, ruleB.id)).toEqual([]);
    expect(await getConditionTree(shopA.id, ruleB.id)).toEqual([]);

    await expect(
      updateConditionGroup(shopA.id, ruleA.id, foreign.id, { position: 4 }),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);

    await expect(
      deleteConditionGroup(shopA.id, ruleA.id, foreign.id),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);

    await expect(
      createCondition(shopA.id, ruleA.id, foreign.id, {
        field: "CART_LINE_COUNT",
        operator: "EQ",
        value: 1,
      }),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);

    await expect(
      updateCondition(shopA.id, ruleA.id, foreignCondition.id, {
        value: 10,
      }),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);

    await expect(
      deleteCondition(shopA.id, ruleA.id, foreignCondition.id),
    ).rejects.toBeInstanceOf(TenantResourceNotFoundError);

    const untouched = await prisma.offerConditionGroup.findUnique({
      where: { id: foreign.id },
    });
    const untouchedCondition = await prisma.offerCondition.findUnique({
      where: { id: foreignCondition.id },
    });
    expect(untouched?.shopId).toBe(shopB.id);
    expect(untouched?.position).toBe(0);
    expect(untouchedCondition?.valueJson).toBe(50);
  });

  it("cascades child groups and conditions when a parent is deleted", async () => {
    const rule = await createRule(shopA.id, ruleInput("Cascade rule"));
    const root = await createConditionGroup(shopA.id, rule.id);
    const child = await createConditionGroup(shopA.id, rule.id, {
      parentGroupId: root.id,
    });
    await createCondition(shopA.id, rule.id, root.id, {
      field: "CUSTOMER_LOGGED_IN",
      operator: "EQ",
      value: true,
    });
    await createCondition(shopA.id, rule.id, child.id, {
      field: "MARKET_COUNTRY",
      operator: "EQ",
      value: "US",
    });

    await deleteConditionGroup(shopA.id, rule.id, root.id);

    expect(
      await prisma.offerConditionGroup.count({
        where: { id: { in: [root.id, child.id] } },
      }),
    ).toBe(0);
    expect(
      await prisma.offerCondition.count({
        where: { groupId: { in: [root.id, child.id] } },
      }),
    ).toBe(0);
  });

  it("cascades the whole tree when the rule is deleted", async () => {
    const rule = await createRule(shopA.id, ruleInput("Deleted rule"));
    const root = await createConditionGroup(shopA.id, rule.id);
    const child = await createConditionGroup(shopA.id, rule.id, {
      parentGroupId: root.id,
    });
    await createCondition(shopA.id, rule.id, child.id, {
      field: "TIME_WINDOW",
      operator: "IN",
      value: { days: [1], start: "09:00", end: "17:00" },
    });

    await deleteRule(shopA.id, rule.id);

    expect(
      await prisma.offerConditionGroup.count({ where: { ruleId: rule.id } }),
    ).toBe(0);
    expect(
      await prisma.offerCondition.count({ where: { groupId: child.id } }),
    ).toBe(0);
  });

  it("enforces the group cap per rule", async () => {
    const rule = await createRule(shopA.id, ruleInput("Group cap rule"));
    for (let index = 0; index < 5; index += 1) {
      await createConditionGroup(shopA.id, rule.id);
    }

    await expect(
      createConditionGroup(shopA.id, rule.id),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("enforces the condition cap per rule", async () => {
    const rule = await createRule(shopA.id, ruleInput("Condition cap rule"));
    const root = await createConditionGroup(shopA.id, rule.id);
    for (let index = 0; index < 20; index += 1) {
      await createCondition(shopA.id, rule.id, root.id, {
        field: "CART_SUBTOTAL",
        operator: "GTE",
        value: index,
      });
    }

    await expect(
      createCondition(shopA.id, rule.id, root.id, {
        field: "CART_SUBTOTAL",
        operator: "GTE",
        value: 99,
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});
