// One lifecycle pass from the command line (e.g. from cron).
// Usage: npm run lifecycle            → purge expired trash, prune versions, delete orphans
//        npm run lifecycle -- --dry-run → only report what reconcile would delete
import { prisma } from "../src/db";
import { runLifecycle } from "../src/lifecycle";
import { s3 } from "../src/storage";

runLifecycle({ dryRun: process.argv.includes("--dry-run") })
  .then((summary) => console.log(JSON.stringify(summary, null, 2)))
  .finally(async () => {
    await prisma.$disconnect();
    s3.destroy();
  });
