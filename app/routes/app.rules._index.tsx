import { redirect } from "react-router";

/** The rule list became the Offers page. */
export const loader = async () => redirect("/app/offers");
export const action = async () => redirect("/app/offers");
