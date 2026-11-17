import { redirect } from "react-router";

/** Catch-all for bookmarked rule URLs; the workflow lives under /app/offers. */
export const loader = async () => redirect("/app/offers");
export const action = async () => redirect("/app/offers");
