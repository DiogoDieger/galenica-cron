// src/services/magentoProductsDetailedSync.ts
import { PrismaClient, MagentoProductStatus } from "@prisma/client";

const prisma = new PrismaClient();

const MAGENTO_SOAP_URL = process.env.MAGENTO_API_URL ?? "";
const MAGENTO_API_USER = process.env.MAGENTO_API_USER ?? "";
const MAGENTO_API_KEY = process.env.MAGENTO_API_KEY ?? "";

export interface CatalogProductReturnEntity {
  product_id: string;
  sku: string;
  set?: string;
  type?: string;
  categories?: string[];
  websites?: string[];
  created_at?: string;
  updated_at?: string;
  type_id?: string;
  name?: string;
  description?: string;
  short_description?: string;
  weight?: string;
  status?: string;
  url_key?: string;
  url_path?: string;
  visibility?: string;
  category_ids?: string[];
  price?: string;
  special_price?: string;
  // estoque
  qty?: string;
  is_in_stock?: string;
  min_qty?: string;
  max_qty?: string;
  // custom
  batch?: string;
  expiry_date?: string;
  manufacturer?: string;
  active_ingredient?: string;
  dosage?: string;
}

interface SyncStats {
  totalProducts: number;
  processedProducts: number;
  newProducts: number;
  updatedProducts: number;
  errorProducts: number;
  startTime: Date;
  endTime?: Date;
  duration?: string;
  errors: Array<{ productId: string; error: string }>;
}

type SyncResult =
  | { success: true; stats: SyncStats; diagnostics?: any; product?: any }
  | { success: false; error: string; stats: SyncStats; diagnostics?: any };

// ───────────────── helpers de tempo/diag ─────────────────
function nowMs() {
  const [sec, ns] = process.hrtime();
  return sec * 1000 + ns / 1e6;
}
function elapsed(start: number) {
  return `${(nowMs() - start).toFixed(0)}ms`;
}
function seconds(stats: SyncStats) {
  return `${Math.round(
    (stats.endTime!.getTime() - stats.startTime.getTime()) / 1000
  )}s`;
}
function maskUrl(url?: string) {
  if (!url) return null;
  try {
    const u = new URL(url.includes("?wsdl") ? url : `${url}?wsdl`);
    return `${u.origin}${u.pathname}?wsdl`;
  } catch {
    return url;
  }
}
function preview(v: any) {
  try {
    return JSON.stringify(v, null, 2).slice(0, 600);
  } catch {
    return String(v).slice(0, 600);
  }
}
function wrapErr(ctx: string, e: any) {
  const m = e?.message || String(e);
  return new Error(`${ctx}: ${m}`);
}

// ───────────────────────── SOAP baixo nível ─────────────────────────
function ensureEnv() {
  if (!MAGENTO_SOAP_URL || !MAGENTO_API_USER || !MAGENTO_API_KEY) {
    throw new Error("Credenciais/URL do Magento não configuradas (env)");
  }
}

async function soapCall(bodyXml: string, soapAction: string) {
  const resp = await fetch(MAGENTO_SOAP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: soapAction,
    },
    body: bodyXml,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 200)}`);
  }
  // faults?
  if (text.includes("<faultcode") || text.includes("<faultstring")) {
    const fault = text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/);
    throw new Error(fault?.[1] || "SOAP Fault");
  }
  return text;
}

async function getMagentoSession(): Promise<string> {
  ensureEnv();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:ns1="urn:Magento"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"
    SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
    <SOAP-ENV:Body>
      <ns1:login>
        <username xsi:type="xsd:string">${MAGENTO_API_USER}</username>
        <apiKey xsi:type="xsd:string">${MAGENTO_API_KEY}</apiKey>
      </ns1:login>
    </SOAP-ENV:Body>
  </SOAP-ENV:Envelope>`;

  const resp = await soapCall(xml, "urn:Magento#login");
  // tenta vários padrões de retorno
  const patterns = [
    /<[^:>]*:?loginReturn[^>]*>([\s\S]*?)<\/[^:>]*:?loginReturn>/,
    /<result[^>]*>([\s\S]*?)<\/result>/,
    />([A-Za-z0-9]+)</,
  ];
  for (const p of patterns) {
    const m = resp.match(p);
    if (m?.[1] && m[1].length > 10) return m[1];
  }
  throw new Error("Não foi possível extrair sessionId do login SOAP");
}

function extractXmlValue(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

function extractItems(xml: string, container = "item"): string[] {
  const re = new RegExp(`<${container}[^>]*>[\\s\\S]*?<\\/${container}>`, "g");
  return xml.match(re) || [];
}

// ───── catalogProductList ─────
async function catalogProductList(
  sessionId: string,
  storeView?: string
): Promise<Array<{ product_id: string; sku: string }>> {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:ns1="urn:Magento"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"
    SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
    <SOAP-ENV:Body>
      <ns1:catalogProductList>
        <sessionId xsi:type="xsd:string">${sessionId}</sessionId>
        ${
          storeView
            ? `<storeView xsi:type="xsd:string">${storeView}</storeView>`
            : `<storeView xsi:nil="true"/>`
        }
        <filters xsi:nil="true"/>
      </ns1:catalogProductList>
    </SOAP-ENV:Body>
  </SOAP-ENV:Envelope>`;
  const resp = await soapCall(xml, "urn:Magento#catalogProductList");

  const items = extractItems(resp, "item");
  const out: Array<{ product_id: string; sku: string }> = [];
  for (const it of items) {
    const product_id =
      extractXmlValue(it, "product_id") ?? extractXmlValue(it, "productId");
    const sku = extractXmlValue(it, "sku");
    if (product_id && sku) out.push({ product_id, sku });
  }
  return out;
}

// ───── catalogProductInfo ─────
async function catalogProductInfo(
  sessionId: string,
  productId: string,
  storeView?: string,
  identifierType: "id" | "sku" = "id"
): Promise<CatalogProductReturnEntity> {
  // atributos “essenciais”; Magento ignora quando não se aplica
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:ns1="urn:Magento"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"
    SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
    <SOAP-ENV:Body>
      <ns1:catalogProductInfo>
        <sessionId xsi:type="xsd:string">${sessionId}</sessionId>
        <productId xsi:type="xsd:string">${productId}</productId>
        ${
          storeView
            ? `<storeView xsi:type="xsd:string">${storeView}</storeView>`
            : `<storeView xsi:nil="true"/>`
        }
        <attributes xsi:nil="true"/>
        <identifierType xsi:type="xsd:string">${identifierType}</identifierType>
      </ns1:catalogProductInfo>
    </SOAP-ENV:Body>
  </SOAP-ENV:Envelope>`;

  const resp = await soapCall(xml, "urn:Magento#catalogProductInfo");

  const extract = (t: string) => extractXmlValue(resp, t) ?? undefined;
  const toArr = (t: string) => {
    const raw = extractXmlValue(resp, t);
    if (!raw) return undefined;
    // pode vir separado por vírgulas ou múltiplos <item>
    const items = extractItems(resp, t).length
      ? extractItems(resp, "item").map((x) =>
          x.replace(/<\/?item[^>]*>/g, "").trim()
        )
      : raw.split(",").map((s) => s.trim());
    return items.filter(Boolean);
  };

  return {
    product_id: extract("product_id") || extract("productId") || "",
    sku: extract("sku") || "",
    set: extract("set"),
    type_id: extract("type_id"),
    name: extract("name"),
    description: extract("description"),
    short_description: extract("short_description"),
    weight: extract("weight"),
    status: extract("status"),
    visibility: extract("visibility"),
    category_ids: toArr("category_ids"),
    categories: toArr("categories"),
    price: extract("price"),
    special_price: extract("special_price"),
    // custom (se existirem no seu Magento)
    batch: extract("batch"),
    expiry_date: extract("expiry_date"),
    manufacturer: extract("manufacturer"),
    active_ingredient: extract("active_ingredient"),
    dosage: extract("dosage"),
  };
}

// ───── catalogInventoryStockItemList (em lote) ─────
async function stockItemList(
  sessionId: string,
  productIds: string[]
): Promise<
  Record<
    string,
    { qty?: string; is_in_stock?: string; min_qty?: string; max_qty?: string }
  >
> {
  if (productIds.length === 0) return {};
  // Alguns WSDLs aceitam <products><item>id</item>...</products>
  const productsXml = productIds
    .map((id) => `<item xsi:type="xsd:string">${id}</item>`)
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:ns1="urn:Magento"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"
    SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
    <SOAP-ENV:Body>
      <ns1:catalogInventoryStockItemList>
        <sessionId xsi:type="xsd:string">${sessionId}</sessionId>
        <products SOAP-ENC:arrayType="xsd:string[${productIds.length}]" xsi:type="SOAP-ENC:Array">
          ${productsXml}
        </products>
      </ns1:catalogInventoryStockItemList>
    </SOAP-ENV:Body>
  </SOAP-ENV:Envelope>`;

  const resp = await soapCall(xml, "urn:Magento#catalogInventoryStockItemList");
  const items = extractItems(resp, "item");

  const out: Record<string, any> = {};
  for (const it of items) {
    const pid =
      extractXmlValue(it, "product_id") ||
      extractXmlValue(it, "productId") ||
      "";
    if (!pid) continue;
    out[pid] = {
      qty: extractXmlValue(it, "qty") ?? undefined,
      is_in_stock: extractXmlValue(it, "is_in_stock") ?? undefined,
      min_qty: extractXmlValue(it, "min_qty") ?? undefined,
      max_qty: extractXmlValue(it, "max_qty") ?? undefined,
    };
  }
  return out;
}

// ───────────────────────── serviço principal ─────────────────────────
export async function syncDetailedProducts(
  options: {
    productId?: string;
    sku?: string;
    batchSize?: number;
    force?: boolean;
    storeView?: string;
    debug?: boolean;
  } = {}
): Promise<SyncResult> {
  const requestId = Math.random().toString(36).slice(2, 8);
  const {
    productId,
    sku,
    batchSize = 25,
    force = false,
    storeView,
    debug = true,
  } = options;

  const stats: SyncStats = {
    totalProducts: 0,
    processedProducts: 0,
    newProducts: 0,
    updatedProducts: 0,
    errorProducts: 0,
    startTime: new Date(),
    errors: [],
  };

  const diagnostics: any = {
    requestId,
    opts: { productId, sku, batchSize, force, storeView },
    env: {
      MAGENTO_API_URL: maskUrl(process.env.MAGENTO_API_URL),
      MAGENTO_API_USER: !!process.env.MAGENTO_API_USER,
      MAGENTO_API_KEY: !!process.env.MAGENTO_API_KEY,
    },
    steps: [],
  };
  const log = (...a: any[]) =>
    debug && console.log(`[syncDetailed:${requestId}]`, ...a);
  const logErr = (...a: any[]) =>
    console.error(`[syncDetailed:${requestId}]`, ...a);

  try {
    ensureEnv();
    const tLogin = nowMs();
    const sessionId = await getMagentoSession();

    diagnostics.steps.push({ step: "login", ok: true, ms: elapsed(tLogin) });

    // 1) Produto único?
    if (productId || sku) {
      const id = productId || sku!;
      const type: "id" | "sku" = productId ? "id" : "sku";

      const tInfo = nowMs();
      let productInfo = await catalogProductInfo(
        sessionId,
        id,
        storeView,
        type
      );
      diagnostics.steps.push({
        step: "catalogProductInfo(single)",
        ok: true,
        ms: elapsed(tInfo),
      });

      const tStock = nowMs();
      try {
        const stock = await stockItemList(sessionId, [productInfo.product_id]);
        const s = stock[productInfo.product_id];
        if (s) {
          productInfo.qty = s.qty;
          productInfo.is_in_stock = s.is_in_stock;
          productInfo.min_qty = s.min_qty;
          productInfo.max_qty = s.max_qty;
        }
        diagnostics.steps.push({
          step: "stockItemList(single)",
          ok: true,
          ms: elapsed(tStock),
        });
      } catch (e: any) {
        diagnostics.steps.push({
          step: "stockItemList(single)",
          ok: false,
          ms: elapsed(tStock),
          error: e?.message,
        });
        logErr("stockItemList(single) ERROR:", e);
      }

      const tSave = nowMs();
      const result = await saveProductToDatabase(productInfo, force);
      diagnostics.steps.push({
        step: "saveProductToDatabase(single)",
        ok: true,
        ms: elapsed(tSave),
        isNew: result.isNew,
      });

      stats.totalProducts = 1;
      stats.processedProducts = 1;
      if (result.isNew) stats.newProducts = 1;
      else stats.updatedProducts = 1;

      stats.endTime = new Date();
      stats.duration = seconds(stats);

      return { success: true, stats, diagnostics, product: result.product };
    }

    // 2) Sync completo
    const tList = nowMs();
    let list = await catalogProductList(sessionId, storeView);
    diagnostics.steps.push({
      step: "catalogProductList",
      ok: true,
      ms: elapsed(tList),
      length: list.length,
    });
    stats.totalProducts = list.length;

    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      log(
        `batch ${i / batchSize + 1}/${Math.ceil(list.length / batchSize)} (${
          batch.length
        } itens)`
      );

      // detalhes
      const tDetails = nowMs();
      const details = await Promise.all(
        batch.map(async (p) => {
          try {
            return await catalogProductInfo(
              sessionId,
              p.product_id,
              storeView,
              "id"
            );
          } catch (e: any) {
            stats.errors.push({
              productId: p.product_id,
              error: e?.message || String(e),
            });
            return null;
          }
        })
      );
      diagnostics.steps.push({
        step: "catalogProductInfo(batch)",
        ok: true,
        ms: elapsed(tDetails),
        requested: batch.length,
        returnedNonNull: details.filter(Boolean).length,
      });

      const valid = details.filter((x): x is CatalogProductReturnEntity => !!x);
      if (valid.length > 0) {
        // estoque em lote
        const tStock = nowMs();
        try {
          const stock = await stockItemList(
            sessionId,
            valid.map((v) => v.product_id)
          );
          for (const v of valid) {
            const s = stock[v.product_id];
            if (s) {
              v.qty = s.qty;
              v.is_in_stock = s.is_in_stock;
              v.min_qty = s.min_qty;
              v.max_qty = s.max_qty;
            }
          }
          diagnostics.steps.push({
            step: "stockItemList(batch)",
            ok: true,
            ms: elapsed(tStock),
            count: valid.length,
          });
        } catch (e: any) {
          diagnostics.steps.push({
            step: "stockItemList(batch)",
            ok: false,
            ms: elapsed(tStock),
            error: e?.message,
          });
          logErr("stockItemList(batch) ERROR:", e);
        }

        // salvar
        const tSave = nowMs();
        for (const v of valid) {
          try {
            const saved = await saveProductToDatabase(v, force);
            stats.processedProducts++;
            if (saved.isNew) stats.newProducts++;
            else stats.updatedProducts++;
          } catch (e: any) {
            stats.errorProducts++;
            stats.errors.push({
              productId: v.product_id,
              error: e?.message || String(e),
            });
          }
        }
        diagnostics.steps.push({
          step: "saveProductToDatabase(batch)",
          ok: true,
          ms: elapsed(tSave),
          saved: valid.length,
        });
      }

      // respiro opcional
      if (i + batchSize < list.length)
        await new Promise((r) => setTimeout(r, 500));
    }

    stats.endTime = new Date();
    stats.duration = seconds(stats);

    const diagOut = { ...diagnostics, errorsSample: stats.errors.slice(0, 5) };
    return { success: true, stats, diagnostics: diagOut };
  } catch (err: any) {
    stats.endTime = new Date();
    stats.duration = seconds(stats);
    const msg = err?.message || "unknown";
    diagnostics.fail = msg;
    const diagOut = { ...diagnostics, errorsSample: stats.errors.slice(0, 5) };
    return { success: false, error: msg, stats, diagnostics: diagOut };
  }
}

// ───────────────────────── persistência ─────────────────────────
async function saveProductToDatabase(
  productInfo: CatalogProductReturnEntity,
  _force = false
) {
  const existing = await prisma.magentoProduct.findFirst({
    where: {
      OR: [{ productId: productInfo.product_id }, { sku: productInfo.sku }],
    },
  });

  const data = {
    productId: productInfo.product_id,
    sku: productInfo.sku,
    name: productInfo.name || "Produto sem nome",
    description: productInfo.description || null,
    shortDescription: productInfo.short_description || null,
    price: parseFloat(productInfo.price || "0"),
    weight: productInfo.weight ? parseFloat(productInfo.weight) : null,
    qty: parseFloat(productInfo.qty || "0"),
    isInStock: productInfo.is_in_stock === "1",
    status: (productInfo.status === "1"
      ? "ENABLED"
      : "DISABLED") as MagentoProductStatus,
    batch: productInfo.batch || null,
    expiryDate: productInfo.expiry_date || null,
    manufacturer: productInfo.manufacturer || null,
    activeIngredient: productInfo.active_ingredient || null,
    dosage: productInfo.dosage || null,
    syncedAt: new Date(),
  };

  if (existing) {
    const updated = await prisma.magentoProduct.update({
      where: { id: existing.id },
      data,
    });
    return { product: updated, isNew: false };
  } else {
    const created = await prisma.magentoProduct.create({ data });
    return { product: created, isNew: true };
  }
}
