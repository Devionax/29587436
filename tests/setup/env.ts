import { TEST_DATABASE_URL } from "./constants";

// Runs before each test file, before application modules are evaluated, so the
// Prisma singleton connects to the test cluster instead of the developer's DB.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DIRECT_URL = TEST_DATABASE_URL;
process.env.LOG_LEVEL = "error";

// shopify.server.ts validates its configuration at import time. These values are
// fake: no test calls Shopify, and route tests override the proxy secret.
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.SHOPIFY_APP_URL = "https://test-app.example";
process.env.SCOPES = "read_products,read_orders";
