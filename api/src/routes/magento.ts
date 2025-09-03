// src/routes/magento.ts
import { Router } from "express";
import { syncAllProductsFromMagento } from "../services/magentoProductsSync.js";
import { syncDetailedProducts } from "../services/magentoProductsDetailedSync.js";
import {
  syncAllOrdersShippingAddressesSingleSession,
  updateAddressAndSyncOrders,
} from "../services/updateAddres.js";
import { syncAllOrderInfos } from "../services/syncOrderInfo.js";

const router = Router();

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

    // 🔒 proteção contra undefined
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
router.post("/orders/sync-shipping/all-single-session", async (req, res) => {
  try {
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

router.post("/orders/sync-info", async (req, res) => {
  try {
    const onlyMissing = req.query.onlyMissing !== "false"; // default true
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
