import { redirect } from "react-router";

/** Rule editing moved into the offer workflow; the record ids are the same. */
export const loader = async ({ params }: { params: { ruleId?: string } }) =>
  redirect(params.ruleId ? `/app/offers/${params.ruleId}` : "/app/offers");
export const action = async ({ params }: { params: { ruleId?: string } }) =>
  redirect(params.ruleId ? `/app/offers/${params.ruleId}` : "/app/offers");
