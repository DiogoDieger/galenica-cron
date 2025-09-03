// src/services/debugOrderInfo.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  getMagentoSession,
  salesOrderInfo,
  parseSalesOrder,
  upsertOrderAndItems,
} from "./syncOrderInfo.js";

const prisma = new PrismaClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Como usar:
 * - 1 pedido específico:
 *   npx tsx src/services/debugOrderInfo.ts 100000389
 *
 * - Lote (somente pedidos sem detalhes - detailsFetched=false) [padrão]:
 *   npx tsx src/services/debugOrderInfo.ts
 *
 * - Lote (todos os pedidos):
 *   npx tsx src/services/debugOrderInfo.ts --all
 *
 * Flags opcionais para lote:
 *   --limit=200 --concurrency=5 --pause=300
 */

(async () => {
  const argInc = process.argv[2]; // incrementId OU flag (--all / --missing)
  const args = new Map<string, string>();
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args.set(m[1], m[2] ?? "true");
  }

  const onlyMissing =
    (!argInc && !args.has("all")) ||
    args.has("missing"); // padrão: só os que faltam
  const limit = Number(args.get("limit") ?? 200);
  const concurrency = Number(args.get("concurrency") ?? 5);
  const pauseMsBetweenBatches = Number(args.get("pause") ?? 300);

  try {
    const session = await getMagentoSession();
    console.log(
      `[orders:info] start. single=${/^\d+$/.test(argInc ?? "")} onlyMissing=${onlyMissing} limit=${limit} concurrency=${concurrency}`
    );

    // MODO 1: um único pedido (se foi passado um número como primeiro argumento)
    if (argInc && /^\d+$/.test(argInc)) {
      const inc = argInc;
      console.log(`[orders:info][${inc}] fetching…`);
      const xml = await salesOrderInfo(session, inc);
      const parsed = parseSalesOrder(xml);

      console.log(`[orders:info][${inc}] parsed. items=${parsed.items.length}`);
      await upsertOrderAndItems(inc, parsed);
      console.log(`[orders:info][${inc}] saved. ✅`);
      process.exit(0);
    }

    // MODO 2: lote (missing por padrão, ou todos com --all)
    const where = onlyMissing ? { detailsFetched: false } : {};
    const orders = await prisma.order.findMany({
      where,
      select: { incrementId: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    console.log(`[orders:info] found ${orders.length} orders to process.`);

    let ok = 0,
      fail = 0,
      totalItems = 0;

    for (let i = 0; i < orders.length; i += concurrency) {
      const batch = orders.slice(i, i + concurrency);

      await Promise.all(
        batch.map(async (o) => {
          const inc = o.incrementId;
          const tag = `[orders:info][${inc}]`;
          try {
            console.log(`${tag} fetching…`);
            const xml = await salesOrderInfo(session, inc);
            const parsed = parseSalesOrder(xml);
            console.log(`${tag} parsed. items=${parsed.items.length}`);
            await upsertOrderAndItems(inc, parsed);
            console.log(`${tag} saved. ✅`);
            ok++;
            totalItems += parsed.items.length;
          } catch (e: any) {
            console.error(`${tag} ERROR: ${e?.message || String(e)}`);
            fail++;
          }
        })
      );

      if (i + concurrency < orders.length && pauseMsBetweenBatches > 0) {
        await sleep(pauseMsBetweenBatches);
      }
    }

    console.log(
      `[orders:info] done. ok=${ok} fail=${fail} totalItems=${totalItems}`
    );
    process.exit(0);
  } catch (e: any) {
    console.error(e?.message || e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
