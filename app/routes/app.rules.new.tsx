import { redirect } from "react-router";

/** Rule creation moved into the offer wizard. */
export const loader = async () => redirect("/app/offers/new");
export const action = async () => redirect("/app/offers/new");
