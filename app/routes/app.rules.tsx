import { redirect } from "react-router";

/**
 * The rule editor was replaced by the offer workflow. Old links (including
 * bookmarks to a specific rule) land on the offers list; rule ids and offer ids
 * are the same record, but the list is the safe target while the new UI ships.
 */
export const loader = async () => redirect("/app/offers");
export const action = async () => redirect("/app/offers");
