import { PrismaClient, OrderStatus } from "@prisma/client";

const prisma = new PrismaClient();

const MAGENTO_SOAP_URL = process.env.MAGENTO_API_URL ?? "";
const MAGENTO_API_USER = process.env.MAGENTO_API_USER ?? "";
const MAGENTO_API_KEY = process.env.MAGENTO_API_KEY ?? "";

/** util tempo */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(
  process.env.MAGENTO_API_URL,
  process.env.MAGENTO_API_USER,
  process.env.MAGENTO_API_KEY
);

/** ─────────── SOAP helpers ─────────── */
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
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 300)}`);
  }
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

/** ─────────── Regex helpers (tolerantes a namespace) ─────────── */
function extractXmlValue(xml: string, tag: string): string | null {
  // aceita <tag> ... </tag> e <ns:tag> ... </ns:tag>
  const re = new RegExp(
    `<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`,
    "i"
  );
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function extractBlocks(xml: string, tag: string): string[] {
  // retorna blocos inteiros da tag, com ou sem namespace
  const re = new RegExp(
    `<(?:\\w+:)?${tag}[^>]*>[\\s\\S]*?<\\/(?:\\w+:)?${tag}>`,
    "gi"
  );
  return xml.match(re) || [];
}

/** Concatena linhas do <street> quando vier como <street><item>...</item>...</street> */
function extractStreet(blockXml: string): string | null {
  const streetBlock = extractBlocks(blockXml, "street")[0];
  if (!streetBlock) return extractXmlValue(blockXml, "street");

  const items = extractBlocks(streetBlock, "item");
  if (items.length) {
    const lines = items
      .map((it) => it.replace(/<\/?item[^>]*>/gi, "").trim())
      .filter(Boolean);
    return lines.join(" ");
  }
  const raw = streetBlock.replace(/<\/?[^>]+>/g, "").trim();
  return raw || null;
}

/** ─────────── salesOrderInfo (SOAP V2) ─────────── */
async function salesOrderInfo(sessionId: string, orderIncrementId: string) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:ns1="urn:Magento"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"
    SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
    <SOAP-ENV:Body>
      <ns1:salesOrderInfo>
        <sessionId xsi:type="xsd:string">${sessionId}</sessionId>
        <orderIncrementId xsi:type="xsd:string">${orderIncrementId}</orderIncrementId>
      </ns1:salesOrderInfo>
    </SOAP-ENV:Body>
  </SOAP-ENV:Envelope>`;

  const resp = await soapCall(xml, "urn:Magento#salesOrderInfo");
  return resp;
}

/** ─────────── Parse completo do salesOrderInfo ─────────── */
function parseSalesOrder(xml: string) {
  const get = (tag: string) => extractXmlValue(xml, tag);

  // Blocos de endereço
  const billingBlock = extractBlocks(xml, "billing_address")[0] || "";
  const shippingBlock = extractBlocks(xml, "shipping_address")[0] || "";

  // Preferir os campos dentro dos blocos; fallback para variantes "flattened"
  const billing_firstname =
    extractXmlValue(billingBlock, "firstname") || get("billing_firstname");
  const billing_lastname =
    extractXmlValue(billingBlock, "lastname") || get("billing_lastname");
  const billing_city =
    extractXmlValue(billingBlock, "city") || get("billing_city");
  const billing_country_id =
    extractXmlValue(billingBlock, "country_id") || get("billing_country_id");
  const billing_postcode =
    extractXmlValue(billingBlock, "postcode") || get("billing_postcode");
  const billing_region =
    extractXmlValue(billingBlock, "region") || get("billing_region");
  const billing_telephone =
    extractXmlValue(billingBlock, "telephone") || get("billing_telephone");
  const billing_street = extractStreet(billingBlock) || get("billing_street");

  const shipping_firstname =
    extractXmlValue(shippingBlock, "firstname") || get("shipping_firstname");
  const shipping_lastname =
    extractXmlValue(shippingBlock, "lastname") || get("shipping_lastname");
  const shipping_city =
    extractXmlValue(shippingBlock, "city") || get("shipping_city");
  const shipping_country_id =
    extractXmlValue(shippingBlock, "country_id") || get("shipping_country_id");
  const shipping_postcode =
    extractXmlValue(shippingBlock, "postcode") || get("shipping_postcode");
  const shipping_region =
    extractXmlValue(shippingBlock, "region") || get("shipping_region");
  const shipping_telephone =
    extractXmlValue(shippingBlock, "telephone") || get("shipping_telephone");
  const shipping_street =
    extractStreet(shippingBlock) || get("shipping_street");

  const header = {
    increment_id: get("increment_id") || "",
    parent_id: get("parent_id") || null,
    store_id: get("store_id") || null,
    created_at: get("created_at") || null,
    updated_at: get("updated_at") || null,
    is_active: get("is_active") || null,
    customer_id: get("customer_id") || null,

    tax_amount: get("tax_amount"),
    shipping_amount: get("shipping_amount"),
    discount_amount: get("discount_amount"),
    subtotal: get("subtotal"),
    grand_total: get("grand_total"),
    total_paid: get("total_paid"),
    total_refunded: get("total_refunded"),
    total_qty_ordered: get("total_qty_ordered"),

    base_tax_amount: get("base_tax_amount"),
    base_shipping_amount: get("base_shipping_amount"),
    base_discount_amount: get("base_discount_amount"),
    base_subtotal: get("base_subtotal"),
    base_grand_total: get("base_grand_total"),
    base_total_paid: get("base_total_paid"),
    base_total_refunded: get("base_total_refunded"),

    customer_email: get("customer_email") || "",
    customer_firstname: get("customer_firstname") || "",
    customer_lastname: get("customer_lastname") || "",

    // Endereços (dos blocos, com fallback)
    billing_firstname,
    billing_lastname,
    billing_city,
    billing_country_id,
    billing_postcode,
    billing_region,
    billing_street,
    billing_telephone,

    shipping_firstname,
    shipping_lastname,
    shipping_city,
    shipping_country_id,
    shipping_postcode,
    shipping_region,
    shipping_street,
    shipping_telephone,

    shipping_method: get("shipping_method"),
    shipping_description: get("shipping_description"),
    status: get("status"),
    state: get("state"),
  };

  // Itens
  const itemsContainer = extractBlocks(xml, "items")[0] || xml;
  const rawItems = extractBlocks(itemsContainer, "item");
  const items = rawItems.map((it) => ({
    item_id: extractXmlValue(it, "item_id") || "",
    product_id: extractXmlValue(it, "product_id") || null,
    sku: extractXmlValue(it, "sku") || null,
    name: extractXmlValue(it, "name") || "Item",
    description: extractXmlValue(it, "description"),
    weight: extractXmlValue(it, "weight"),
    qty_ordered: extractXmlValue(it, "qty_ordered") || "0",
    qty_shipped: extractXmlValue(it, "qty_shipped") || null,
    qty_invoiced: extractXmlValue(it, "qty_invoiced") || null,
    qty_canceled: extractXmlValue(it, "qty_canceled") || null,
    qty_refunded: extractXmlValue(it, "qty_refunded") || null,
    price: extractXmlValue(it, "price") || "0",
    base_price: extractXmlValue(it, "base_price") || null,
    original_price: extractXmlValue(it, "original_price") || null,
    tax_amount: extractXmlValue(it, "tax_amount") || null,
    tax_percent: extractXmlValue(it, "tax_percent") || null,
    discount_amount: extractXmlValue(it, "discount_amount") || null,
    discount_percent: extractXmlValue(it, "discount_percent") || null,
    row_total: extractXmlValue(it, "row_total") || null,
    base_row_total: extractXmlValue(it, "base_row_total") || null,
    product_type: extractXmlValue(it, "product_type") || null,
  }));

  return { header, items };
}

/** Converte string numérica para number com fallback */
const toNum = (v?: string | null, def = 0) =>
  v != null && v !== "" ? Number(v) : def;

/** ─────────── MAPA: Magento status -> Prisma enum ─────────── */
function toPrismaOrderStatus(s?: string | null): OrderStatus | undefined {
  if (!s) return undefined;
  const normalized = s
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
  if ((OrderStatus as any)[normalized]) {
    return (OrderStatus as any)[normalized] as OrderStatus;
  }
  if (normalized === "CANCELLED") return (OrderStatus as any)["CANCELED"];
  return undefined;
}

/** ─────────── Persistência (Order + OrderItem) ─────────── */
async function upsertOrderAndItems(
  orderIncrementId: string,
  parsed: ReturnType<typeof parseSalesOrder>
) {
  // Atualiza cabeçalho do pedido (tabela orders)
  await prisma.order.update({
    where: { incrementId: orderIncrementId },
    data: {
      parentId: parsed.header.parent_id ?? undefined,
      storeId: parsed.header.store_id ?? undefined,
      createdAt: parsed.header.created_at
        ? new Date(parsed.header.created_at)
        : undefined,
      isActive: parsed.header.is_active ?? undefined,
      customerId: parsed.header.customer_id ?? undefined,

      taxAmount: toNum(parsed.header.tax_amount).toFixed(2) as any,
      shippingAmount: toNum(parsed.header.shipping_amount).toFixed(2) as any,
      discountAmount: toNum(parsed.header.discount_amount).toFixed(2) as any,
      subtotal: toNum(parsed.header.subtotal).toFixed(2) as any,
      grandTotal: toNum(parsed.header.grand_total).toFixed(2) as any,
      totalPaid: parsed.header.total_paid
        ? (toNum(parsed.header.total_paid).toFixed(2) as any)
        : undefined,
      totalRefunded: parsed.header.total_refunded
        ? (toNum(parsed.header.total_refunded).toFixed(2) as any)
        : undefined,
      totalQtyOrdered: parsed.header.total_qty_ordered
        ? Math.round(toNum(parsed.header.total_qty_ordered))
        : undefined,

      baseTaxAmount: parsed.header.base_tax_amount
        ? (toNum(parsed.header.base_tax_amount).toFixed(2) as any)
        : undefined,
      baseShippingAmount: parsed.header.base_shipping_amount
        ? (toNum(parsed.header.base_shipping_amount).toFixed(2) as any)
        : undefined,
      baseDiscountAmount: parsed.header.base_discount_amount
        ? (toNum(parsed.header.base_discount_amount).toFixed(2) as any)
        : undefined,
      baseSubtotal: parsed.header.base_subtotal
        ? (toNum(parsed.header.base_subtotal).toFixed(2) as any)
        : undefined,
      baseGrandTotal: parsed.header.base_grand_total
        ? (toNum(parsed.header.base_grand_total).toFixed(2) as any)
        : undefined,
      baseTotalPaid: parsed.header.base_total_paid
        ? (toNum(parsed.header.base_total_paid).toFixed(2) as any)
        : undefined,
      baseTotalRefunded: parsed.header.base_total_refunded
        ? (toNum(parsed.header.base_total_refunded).toFixed(2) as any)
        : undefined,

      customerEmail: parsed.header.customer_email,
      customerFirstname: parsed.header.customer_firstname,
      customerLastname: parsed.header.customer_lastname,

      billingFirstname: parsed.header.billing_firstname ?? undefined,
      billingLastname: parsed.header.billing_lastname ?? undefined,
      shippingFirstname: parsed.header.shipping_firstname ?? undefined,
      shippingLastname: parsed.header.shipping_lastname ?? undefined,

      billingCity: parsed.header.billing_city ?? undefined,
      billingCountryId: parsed.header.billing_country_id ?? undefined,
      billingPostcode: parsed.header.billing_postcode ?? undefined,
      billingRegion: parsed.header.billing_region ?? undefined,
      billingStreet: parsed.header.billing_street ?? undefined,
      billingTelephone: parsed.header.billing_telephone ?? undefined,
      shippingCity: parsed.header.shipping_city ?? undefined,
      shippingCountryId: parsed.header.shipping_country_id ?? undefined,
      shippingPostcode: parsed.header.shipping_postcode ?? undefined,
      shippingRegion: parsed.header.shipping_region ?? undefined,
      shippingStreet: parsed.header.shipping_street ?? undefined,
      shippingTelephone: parsed.header.shipping_telephone ?? undefined,

      shippingMethod: parsed.header.shipping_method ?? undefined,
      shippingDescription: parsed.header.shipping_description ?? undefined,

      status: toPrismaOrderStatus(parsed.header.status),
      state: parsed.header.state ?? undefined,

      detailsFetched: true,
      detailsFetchedAt: new Date(),
      syncedAt: new Date(),
    },
  });

  // Upsert itens
  for (const it of parsed.items) {
    if (!it.item_id) continue;

    await prisma.orderItem.upsert({
      where: {
        orderId_itemId: { orderId: orderIncrementId, itemId: it.item_id },
      },
      update: {
        productId: it.product_id ?? undefined,
        sku: it.sku ?? undefined,
        name: it.name,
        description: it.description ?? undefined,
        weight: it.weight ? (toNum(it.weight).toFixed(2) as any) : undefined,

        // Quantidades
        qty: toNum(it.qty_ordered).toFixed(2) as any, // espelha qty_ordered
        qtyOrdered: it.qty_ordered
          ? (toNum(it.qty_ordered).toFixed(2) as any)
          : undefined,
        qtyShipped: it.qty_shipped
          ? (toNum(it.qty_shipped).toFixed(2) as any)
          : undefined,
        qtyInvoiced: it.qty_invoiced
          ? (toNum(it.qty_invoiced).toFixed(2) as any)
          : undefined,
        qtyCanceled: it.qty_canceled
          ? (toNum(it.qty_canceled).toFixed(2) as any)
          : undefined,
        qtyRefunded: it.qty_refunded
          ? (toNum(it.qty_refunded).toFixed(2) as any)
          : undefined,

        price: toNum(it.price).toFixed(2) as any,
        basePrice: it.base_price
          ? (toNum(it.base_price).toFixed(2) as any)
          : undefined,
        originalPrice: it.original_price
          ? (toNum(it.original_price).toFixed(2) as any)
          : undefined,
        taxAmount: it.tax_amount
          ? (toNum(it.tax_amount).toFixed(2) as any)
          : undefined,
        taxPercent: it.tax_percent
          ? (toNum(it.tax_percent).toFixed(2) as any)
          : undefined,
        discountAmount: it.discount_amount
          ? (toNum(it.discount_amount).toFixed(2) as any)
          : undefined,
        discountPercent: it.discount_percent
          ? (toNum(it.discount_percent).toFixed(2) as any)
          : undefined,
        rowTotal: it.row_total
          ? (toNum(it.row_total).toFixed(2) as any)
          : undefined,
        baseRowTotal: it.base_row_total
          ? (toNum(it.base_row_total).toFixed(2) as any)
          : undefined,
        productType: it.product_type ?? undefined,
      },
      create: {
        orderId: orderIncrementId,
        itemId: it.item_id,
        productId: it.product_id ?? undefined,
        sku: it.sku ?? undefined,
        name: it.name,
        description: it.description ?? undefined,
        weight: it.weight ? (toNum(it.weight).toFixed(2) as any) : undefined,

        // Quantidades (create)
        qty: toNum(it.qty_ordered).toFixed(2) as any,
        qtyOrdered: it.qty_ordered
          ? (toNum(it.qty_ordered).toFixed(2) as any)
          : undefined,
        qtyShipped: it.qty_shipped
          ? (toNum(it.qty_shipped).toFixed(2) as any)
          : undefined,
        qtyInvoiced: it.qty_invoiced
          ? (toNum(it.qty_invoiced).toFixed(2) as any)
          : undefined,
        qtyCanceled: it.qty_canceled
          ? (toNum(it.qty_canceled).toFixed(2) as any)
          : undefined,
        qtyRefunded: it.qty_refunded
          ? (toNum(it.qty_refunded).toFixed(2) as any)
          : undefined,

        price: toNum(it.price).toFixed(2) as any,
        basePrice: it.base_price
          ? (toNum(it.base_price).toFixed(2) as any)
          : undefined,
        originalPrice: it.original_price
          ? (toNum(it.original_price).toFixed(2) as any)
          : undefined,
        taxAmount: it.tax_amount
          ? (toNum(it.tax_amount).toFixed(2) as any)
          : undefined,
        taxPercent: it.tax_percent
          ? (toNum(it.tax_percent).toFixed(2) as any)
          : undefined,
        discountAmount: it.discount_amount
          ? (toNum(it.discount_amount).toFixed(2) as any)
          : undefined,
        discountPercent: it.discount_percent
          ? (toNum(it.discount_percent).toFixed(2) as any)
          : undefined,
        rowTotal: it.row_total
          ? (toNum(it.row_total).toFixed(2) as any)
          : undefined,
        baseRowTotal: it.base_row_total
          ? (toNum(it.base_row_total).toFixed(2) as any)
          : undefined,
        productType: it.product_type ?? undefined,
        createdAt: new Date(),
      },
    });
  }
}

/** ─────────── Orquestrador ─────────── */
export async function syncAllOrderInfos(
  options: {
    onlyMissing?: boolean;
    limit?: number;
    concurrency?: number;
    pauseMsBetweenBatches?: number;
  } = {}
) {
  const { limit = 200, concurrency = 5, pauseMsBetweenBatches = 300 } = options;

  const sessionId = await getMagentoSession();
  console.log(`[orders:info] SOAP session acquired.`);

  // Se quisesse onlyMissing, poderia filtrar por detailsFetched=false aqui.
  const orders = await prisma.order.findMany({
    select: { incrementId: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  console.log(`[orders:info] found ${orders.length} orders to process.`);

  let ok = 0,
    fail = 0,
    itemCounts: number[] = [];

  for (let i = 0; i < orders.length; i += concurrency) {
    const batch = orders.slice(i, i + concurrency);

    await Promise.all(
      batch.map(async (o) => {
        const inc = o.incrementId;
        if (!inc) return;

        const tag = `[orders:info][${inc}]`;
        console.log(`${tag} fetching salesOrderInfo…`);

        try {
          const xml = await salesOrderInfo(sessionId, inc);
          const parsed = parseSalesOrder(xml);

          console.log(`${tag} parsed. items=${parsed.items.length}`);

          await upsertOrderAndItems(inc, parsed);

          console.log(`${tag} saved. items=${parsed.items.length}`);
          ok++;
          itemCounts.push(parsed.items.length);
        } catch (e: any) {
          console.error(`${tag} ERROR:`, e?.message || String(e));
          fail++;
        }
      })
    );

    if (i + concurrency < orders.length && pauseMsBetweenBatches > 0) {
      await sleep(pauseMsBetweenBatches);
    }
  }

  const totalItems = itemCounts.reduce((a, b) => a + b, 0);
  console.log(
    `[orders:info] done. ok=${ok} fail=${fail} totalItems=${totalItems}`
  );

  return { success: true, processed: ok + fail, ok, fail, totalItems };
}

export {
  getMagentoSession,
  salesOrderInfo,
  parseSalesOrder,
  upsertOrderAndItems,
};
