// src/routes/magento.ts
import { Router } from "express";
import { PrismaClient } from "@prisma/client";

import { syncAllProductsFromMagento } from "../services/magentoProductsSync.js";
import { syncDetailedProducts } from "../services/magentoProductsDetailedSync.js";
import {
  syncAllOrdersShippingAddressesSingleSession,
  updateAddressAndSyncOrders,
} from "../services/updateAddres.js";
import { updateOrderFromMagento } from "../services/updateOrderDetails.js";
import { syncAllOrderInfos } from "../services/syncOrderInfo.js";
import { syncAllOrdersJob } from "../services/syncAllOrders.js"; // 👈 novo import
import { syncAllCustomersJob } from "../services/syncAllCustomers.js";

const prisma = new PrismaClient();
const router = Router();

// ================== Produtos ==================
router.get("/products/sync-all", async (_req, res) => {
  try {
    const result = await syncAllProductsFromMagento();
    if (!result) {
      console.error("[sync-all] result is undefined");
      return res.status(500).json({ success: false, error: "no_result" });
    }
    return res.json(result);
  } catch (e: any) {
    console.error("[sync-all] UNCAUGHT:", e);
    return res
      .status(500)
      .json({ success: false, error: e?.message || "internal" });
  }
});

router.get("/products/sync-detailed", async (req, res) => {
  try {
    const result = await syncDetailedProducts({
      batchSize: req.query.batch_size
        ? parseInt(String(req.query.batch_size))
        : 25,
      force: req.query.force === "true",
      storeView: req.query.store_view as string | undefined,
    });

    if (!result) {
      console.error("[sync-detailed] result is undefined");
      return res.status(500).json({ success: false, error: "no_result" });
    }

    if (result.success === false) {
      console.error(
        "[sync-detailed] FAIL payload:",
        JSON.stringify(result, null, 2)
      );
      return res.status(500).json(result);
    }

    return res.json(result);
  } catch (e: any) {
    console.error("[sync-detailed] UNCAUGHT:", e);
    return res
      .status(500)
      .json({ success: false, error: e?.message || "internal" });
  }
});

// ================== Pedidos ==================

// 🔥 Novo endpoint: sincronização COMPLETA de todos os pedidos
router.post("/orders/sync-all-full", async (_req, res) => {
  try {
    await syncAllOrdersJob();
    return res.json({
      success: true,
      message: "Sincronização completa iniciada",
    });
  } catch (e: any) {
    console.error("[orders/sync-all-full] UNCAUGHT:", e);
    return res
      .status(500)
      .json({ success: false, error: e?.message || "internal" });
  }
});

router.post("/orders/sync-shipping/all-single-session", async (req, res) => {
  try {
    console.log("TESTE");
    const result = await syncAllOrdersShippingAddressesSingleSession({
      onlyMissing: req.query.onlyMissing !== "false", // default true
      concurrency: req.query.concurrency
        ? parseInt(String(req.query.concurrency))
        : 5,
      retries: req.query.retries ? parseInt(String(req.query.retries)) : 2,
      updatedBefore: req.query.updatedBefore
        ? new Date(String(req.query.updatedBefore))
        : undefined,
    });

    return res.json({ success: true, ...result });
  } catch (e: any) {
    console.error("[orders/sync-shipping/all-single-session] UNCAUGHT:", e);
    return res
      .status(500)
      .json({ success: false, error: e?.message || "internal" });
  }
});

router.post("/orders/:incrementId/sync", async (req, res) => {
  try {
    const { incrementId } = req.params;
    if (!incrementId) {
      return res
        .status(400)
        .json({ success: false, error: "incrementId obrigatório" });
    }

    const result = await updateOrderFromMagento(incrementId);
    return res.json(result);
  } catch (e: any) {
    console.error("[orders/:incrementId/sync] UNCAUGHT:", e);
    return res
      .status(500)
      .json({ success: false, error: e?.message || "internal" });
  }
});

// ⚠️ Você tinha duas rotas GET /orders/sync-all (mantive as duas)
router.get("/orders/sync-all", async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 100;
    const onlyMissing = req.query.onlyMissing !== "false";

    const orders = await prisma.order.findMany({
      where: onlyMissing ? { detailsFetched: false } : {},
      take: limit,
      orderBy: { createdAt: "desc" },
    });

    if (orders.length === 0) {
      return res.json({
        success: true,
        message: "Nenhum pedido para atualizar",
        updated: 0,
      });
    }

    let updated = 0;
    const errors: any[] = [];

    for (const order of orders) {
      try {
        const result = await updateOrderFromMagento(order.incrementId);
        if (result?.ok) updated++;
      } catch (e: any) {
        errors.push({
          incrementId: order.incrementId,
          error: e?.message || String(e),
        });
      }
    }

    return res.json({
      success: errors.length === 0,
      total: orders.length,
      updated,
      errors,
    });
  } catch (e: any) {
    console.error("[orders/sync-all] UNCAUGHT:", e);
    return res
      .status(500)
      .json({ success: false, error: e?.message || "internal" });
  }
});

router.post("/customers/sync-all-full", async (_req, res) => {
  try {
    await syncAllCustomersJob();
    return res.json({
      success: true,
      message: "Sincronização completa de clientes iniciada",
    });
  } catch (e: any) {
    console.error("[customers/sync-all-full] UNCAUGHT:", e);
    return res
      .status(500)
      .json({ success: false, error: e?.message || "internal" });
  }
});
router.post("/orders/sync-info", async (req, res) => {
  try {
    const onlyMissing = req.query.onlyMissing !== "false";
    const limit = req.query.limit ? parseInt(String(req.query.limit)) : 200;
    const concurrency = req.query.concurrency
      ? parseInt(String(req.query.concurrency))
      : 5;

    console.log(
      `[HTTP] /orders/sync-info onlyMissing=${onlyMissing} limit=${limit} concurrency=${concurrency}`
    );

    const result = await syncAllOrderInfos({ onlyMissing, limit, concurrency });

    return res.json(result);
  } catch (e: any) {
    console.error("[/orders/sync-info] UNCAUGHT:", e);
    return res
      .status(500)
      .json({ success: false, error: e?.message || "internal" });
  }
});

export default router;
