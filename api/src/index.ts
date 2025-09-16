import express from "express";
import { PrismaClient } from "@prisma/client";
import magentoRouter from "./routes/magento.js";

const prisma = new PrismaClient();
const app = express();
app.use(express.json());

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? "wefuvniqwennj";

app.use((req, res, next) => {
  const token = req.header("x-internal-token");
  if (!INTERNAL_TOKEN || token === INTERNAL_TOKEN) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// 🔹 Rotas Magento (prefixo interno)
app.use("/internal/magento", magentoRouter);

const port = Number(process.env.PORT ?? 3005);
app.listen(port, () =>
  console.log(`[api] running at http://localhost:${port}`)
);
