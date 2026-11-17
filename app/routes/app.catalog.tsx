import { redirect } from "react-router";

/** The catalog browser is gone; product selection now happens in the offer wizard. */
export const loader = async () => redirect("/app/offers/new");
