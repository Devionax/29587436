import { startTestDatabase, stopTestDatabase } from "./test-database";

export default async function globalSetup() {
  await startTestDatabase();

  return async () => {
    await stopTestDatabase();
  };
}
