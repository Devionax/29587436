import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { TEST_DATABASE_URL, TEST_DB_NAME, TEST_DB_PORT } from "./constants";

/**
 * Boots a throwaway PostgreSQL cluster for integration tests, so isolation
 * tests run without Docker or shared credentials. The cluster is deleted on
 * shutdown (persistent: false).
 */

const DATA_DIR = path.join(process.cwd(), ".tmp", "pgdata");
const NATIVE_MARKER = "@embedded-postgres";

let instance: EmbeddedPostgres | undefined;

/**
 * Windows can leave an orphaned cluster behind when a previous test run was
 * killed before teardown finished. Those processes block the port and the
 * shared memory segment, so the next run fails to initialise. Only processes
 * started from this project's embedded-postgres binary are touched.
 */
function killStrayClusters(): void {
  if (process.platform !== "win32") return;

  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\"",
    `| Where-Object { $_.CommandLine -like '*${NATIVE_MARKER}*' }`,
    "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join(" ");

  spawnSync("powershell", ["-NoProfile", "-Command", script], {
    stdio: "ignore",
    timeout: 20_000,
  });
}

function postmasterPid(target: EmbeddedPostgres): number | undefined {
  const internal = target as unknown as { process?: { pid?: number } };
  return internal.process?.pid;
}

function forceStop(target: EmbeddedPostgres): void {
  const pid = postmasterPid(target);
  if (!pid) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 20_000,
    });
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export async function startTestDatabase(): Promise<void> {
  killStrayClusters();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  instance = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres",
    port: TEST_DB_PORT,
    persistent: false,
    onLog: () => {},
  });

  await instance.initialise();
  await instance.start();
  await instance.createDatabase(TEST_DB_NAME);

  const prismaCli = path.join(
    process.cwd(),
    "node_modules",
    "prisma",
    "build",
    "index.js",
  );
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      DIRECT_URL: TEST_DATABASE_URL,
    },
    stdio: "pipe",
  });
}

export async function stopTestDatabase(): Promise<void> {
  if (!instance) return;
  const current = instance;
  instance = undefined;

  // A graceful shutdown occasionally stalls on Windows while a backend is
  // still closing. Do not let that hang the test run; fall back to a forced
  // stop of the cluster this process started.
  let timedOut = false;
  const guard = new Promise<void>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, 20_000).unref();
  });

  try {
    await Promise.race([current.stop(), guard]);
  } catch {
    timedOut = true;
  }

  if (timedOut) {
    forceStop(current);
  }

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
