// api/src/services/updateOrderDetails.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MAGENTO_SOAP_URL = process.env.MAGENTO_API_URL ?? "";
const MAGENTO_API_USER = process.env.MAGENTO_API_USER ?? "";
const MAGENTO_API_KEY = process.env.MAGENTO_API_KEY ?? "";

function requiredEnv() {
  if (!MAGENTO_SOAP_URL || !MAGENTO_API_USER || !MAGENTO_API_KEY) {
    throw new Error("Credenciais/URL do Magento não configuradas");
  }
}

function extractTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : undefined;
}

async function getMagentoSession(): Promise<string> {
  const loginRequest = `<?xml version="1.0" encoding="UTF-8"?>
  <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:Magento">
    <SOAP-ENV:Body>
      <ns1:login>
        <username>${MAGENTO_API_USER}</username>
        <apiKey>${MAGENTO_API_KEY}</apiKey>
      </ns1:login>
    </SOAP-ENV:Body>
  </SOAP-ENV:Envelope>`;

  const resp = await fetch(MAGENTO_SOAP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: loginRequest,
  });

  const text = await resp.text();
  if (!resp.ok || /<faultstring>/.test(text)) {
    throw new Error(`Erro login SOAP: ${text}`);
  }

  const sid =
    text.match(/<loginReturn[^>]*>([\s\S]*?)<\/loginReturn>/)?.[1] ??
    text.match(/<result[^>]*>([\s\S]*?)<\/result>/)?.[1];
  if (!sid) throw new Error("Não foi possível extrair sessionId");
  return sid.trim();
}

async function getOrderInfo(sessionId: string, incrementId: string) {
  const req = `<?xml version="1.0" encoding="UTF-8"?>
  <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:Magento">
    <soapenv:Body>
      <urn:salesOrderInfo>
        <sessionId>${sessionId}</sessionId>
        <orderIncrementId>${incrementId}</orderIncrementId>
      </urn:salesOrderInfo>
    </soapenv:Body>
  </soapenv:Envelope>`;

  const resp = await fetch(MAGENTO_SOAP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: req,
  });

  const text = await resp.text();
  if (!resp.ok || /<faultstring>/.test(text)) {
    const msg = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/)?.[1];
    throw new Error(`Erro salesOrderInfo: ${msg}`);
  }

  return text;
}

function mapMagentoStatusToPrisma(status?: string): any {
  if (!status) return undefined;
  const normalized = status.trim().toUpperCase();

  switch (normalized) {
    case "PENDING":
      return "PENDING";
    case "PROCESSING":
      return "PROCESSING";
    case "EM_PRODUCAO":
      return "EM_PRODUCAO";
    case "SHIPPED":
      return "SHIPPED";
    case "COMPLETE":
      return "COMPLETE";
    case "CANCELED":
      return "CANCELED";
    case "CLOSED":
      return "CLOSED";
    case "REFUNDED":
      return "REFUNDED";
    case "HOLDED":
      return "HOLDED";
    case "PAYMENT_REVIEW":
      return "PAYMENT_REVIEW";
    default:
      return "PENDING"; // fallback seguro
  }
}

export async function updateOrderFromMagento(incrementId: string) {
  requiredEnv();
  const sessionId = await getMagentoSession();
  const xml = await getOrderInfo(sessionId, incrementId);

  const fields = {
    status: mapMagentoStatusToPrisma(extractTag(xml, "status")),
    state: extractTag(xml, "state"),
    grandTotal: extractTag(xml, "grand_total"),
    subtotal: extractTag(xml, "subtotal"),
    taxAmount: extractTag(xml, "tax_amount"),
    shippingAmount: extractTag(xml, "shipping_amount"),
    discountAmount: extractTag(xml, "discount_amount"),
    totalPaid: extractTag(xml, "total_paid"),
    shippingMethod: extractTag(xml, "shipping_method"),
    shippingDescription: extractTag(xml, "shipping_description"),
    customerEmail: extractTag(xml, "customer_email"),
    customerFirstname: extractTag(xml, "customer_firstname"),
    customerLastname: extractTag(xml, "customer_lastname"),
    shippingCity: extractTag(xml, "city"),
    shippingPostcode: extractTag(xml, "postcode"),
    shippingRegion: extractTag(xml, "region"),
    shippingStreet: extractTag(xml, "street"),
    shippingTelephone: extractTag(xml, "telephone"),
  };

  const order = await prisma.order.update({
    where: { incrementId },
    data: {
      ...fields,
      detailsFetched: true,
      detailsFetchedAt: new Date(),
      shippingCountryId: "BR",
    },
  });

  return { ok: true, order };
}
