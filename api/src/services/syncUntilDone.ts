// src/services/syncUntilDone.ts
import "dotenv/config";
import { syncAllOrderInfos } from "./syncOrderInfo.js";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args.set(m[1], m[2] ?? "true");
}

// Só os que faltam por padrão (detailsFetched=false). Use --all para reprocessar todos.
const onlyMissing = !args.has("all");
const limit = Number(args.get("limit") ?? 200);
const concurrency = Number(args.get("concurrency") ?? 5);
const pause = Number(args.get("pause") ?? 300); // pausa entre lotes dentro de cada passagem
const sleepBetweenPasses = Number(args.get("sleep") ?? 1500); // pausa entre uma passagem e outra
const maxLoops = Number(args.get("maxLoops") ?? 10000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let loop = 0;
  let totalOk = 0;
  let totalFail = 0;
  let totalItems = 0;

  console.log(
    `[until-done] starting… onlyMissing=${onlyMissing} limit=${limit} concurrency=${concurrency}`
  );

  while (loop < maxLoops) {
    loop++;
    console.log(`\n=== pass ${loop} ===`);

    const res = await syncAllOrderInfos({
      onlyMissing,
      limit,
      concurrency,
      pauseMsBetweenBatches: pause,
    });

    totalOk += res.ok;
    totalFail += res.fail;
    totalItems += res.totalItems ?? 0;

    if (!res.processed || res.processed === 0) {
      console.log("[until-done] finished: no more orders to process. ✅");
      break;
    }

    await sleep(sleepBetweenPasses);
  }

  console.log(
    `\n[until-done] done. passes=${loop} ok=${totalOk} fail=${totalFail} items=${totalItems}`
  );
  process.exit(0);
})();
