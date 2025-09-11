import { PrismaClient } from "@prisma/client";
import { parseStringPromise } from "xml2js";

const prisma = new PrismaClient();

const MAGENTO_SOAP_URL = process.env.MAGENTO_API_URL!;
const MAGENTO_API_USER = process.env.MAGENTO_API_USER!;
const MAGENTO_API_KEY = process.env.MAGENTO_API_KEY!;

interface OrderEntity {
  increment_id: string;
  order_id?: string;
  created_at: string;
  updated_at?: string;
  status: string;
  state?: string;
  grand_total: string;
  subtotal?: string;
  tax_amount?: string;
  shipping_amount?: string;
  discount_amount?: string;
  customer_id?: string;
  customer_email: string;
  customer_firstname: string;
  customer_lastname: string;
  customer_is_guest?: string;
  billing_name?: string;
  billing_street?: string;
  billing_city?: string;
  billing_region?: string;
  billing_postcode?: string;
  billing_country_id?: string;
  billing_telephone?: string;
  shipping_name?: string;
  shipping_street?: string;
  shipping_city?: string;
  shipping_region?: string;
  shipping_postcode?: string;
  shipping_country_id?: string;
  shipping_telephone?: string;
  payment_method?: string;
  shipping_method?: string;
  shipping_description?: string;
  store_id?: string;
  store_name?: string;
  weight?: string;
  total_qty_ordered?: string;
}

export async function syncAllOrdersJob() {
  console.log("=== INICIANDO SINCRONIZAÇÃO COMPLETA DE TODOS OS ORDERS ===");
  const startTime = Date.now();

  try {
    const sessionId = await getMagentoSession();
    console.log("✅ Sessão Magento obtida com sucesso");
    console.log("LOG1");

    const allOrders = await getAllOrdersFromMagento(sessionId);
    console.log(
      `📊 Total de ${allOrders.length} pedidos encontrados no Magento`
    );
    console.log("LOG2");

    const savedOrders = await syncAllOrdersToDatabase(allOrders);
    console.log("LOG3");
    console.log(`💾 ${savedOrders.length} pedidos sincronizados no banco`);
    console.log(`⏱️ Tempo total: ${(Date.now() - startTime) / 1000}s`);
  } catch (err) {
    console.error("❌ Erro na sincronização completa:", err);
  }
}

// ====================== Funções auxiliares ======================

function ensureEnv() {
  if (!MAGENTO_SOAP_URL || !MAGENTO_API_USER || !MAGENTO_API_KEY) {
    throw new Error("Credenciais/URL do Magento não configuradas (env)");
  }
}
async function soapCall(bodyXml: string, soapAction: string) {
  let url = MAGENTO_SOAP_URL;
  if (soapAction === "urn:Magento#salesOrderList") {
    url = `${MAGENTO_SOAP_URL}`;
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: soapAction,
    },
    body: bodyXml,
  });
  const text = await resp.text();
  console.log(resp, "RESPOSTA CARAIO");
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

async function getAllOrdersFromMagento(
  sessionId: string
): Promise<OrderEntity[]> {
  console.log("LOG4");

  // calcula a data/hora de 24h atrás no formato que o Magento espera
  const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19) // pega só YYYY-MM-DDTHH:mm:ss
    .replace("T", " "); // Magento usa espaço em vez de "T"

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:ns1="urn:Magento"
        xmlns:xsd="http://www.w3.org/2001/XMLSchema"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"
        SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
        <SOAP-ENV:Body>
          <ns1:salesOrderList>
            <sessionId xsi:type="xsd:string">${sessionId}</sessionId>
            <filters>
              <complex_filter>
                <item>
                  <key xsi:type="xsd:string">updated_at</key>
                  <value xsi:type="ns1:associativeEntity">
                    <key xsi:type="xsd:string">from</key>
                    <value xsi:type="xsd:string">${fromDate}</value>
                  </value>
                </item>
              </complex_filter>
            </filters>
          </ns1:salesOrderList>
        </SOAP-ENV:Body>
      </SOAP-ENV:Envelope>`;

  console.log("LOG5");
  const text = await soapCall(xml, "urn:Magento#salesOrderList");
  console.log("LOG6");
  return parseOrdersXml(text);
}

function normalize(val: any): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object" && "_" in val) return val._;
  return String(val);
}

async function parseOrdersXml(xml: string): Promise<OrderEntity[]> {
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const response =
    parsed["SOAP-ENV:Envelope"]["SOAP-ENV:Body"]["ns1:salesOrderListResponse"];

  if (!response || !response.result) return [];

  const result = response.result;
  const orders = Array.isArray(result.item) ? result.item : [result.item];

  return orders
    .filter((o: any) => o.increment_id && o.customer_email)
    .map((o: any) => ({
      increment_id: normalize(o.increment_id),
      order_id: normalize(o.order_id),
      created_at: normalize(o.created_at),
      updated_at: normalize(o.updated_at),
      status: normalize(o.status), // 👈 agora sempre string
      grand_total: normalize(o.grand_total),
      customer_email: normalize(o.customer_email),
      customer_firstname: normalize(o.customer_firstname),
      customer_lastname: normalize(o.customer_lastname),
    }));
}

async function syncAllOrdersToDatabase(orders: OrderEntity[]) {
  const saved: any[] = [];

  console.log(orders[0], "ORDERS");
  for (const order of orders) {
    try {
      const savedOrder = await prisma.order.upsert({
        where: { incrementId: order.increment_id },
        update: { status: mapOrderStatus(order.status) },
        create: {
          incrementId: order.increment_id,
          status: mapOrderStatus(order.status),
          grandTotal: parseFloat(order.grand_total),
          customerEmail: order.customer_email,
          customerFirstname: order.customer_firstname,
          customerLastname: order.customer_lastname,
          createdAt: new Date(order.created_at),
          syncedAt: new Date(),
        },
      });
      saved.push(savedOrder);
    } catch (e) {
      console.error(`❌ Erro ao salvar pedido ${order.increment_id}:`, e);
    }
  }

  return saved;
}

function mapOrderStatus(status: string): "PENDING" | "PROCESSING" | "COMPLETE" {
  const map: Record<string, "PENDING" | "PROCESSING" | "COMPLETE"> = {
    pending: "PENDING",
    processing: "PROCESSING",
    complete: "COMPLETE",
  };
  return map[status.toLowerCase()] || "PENDING";
}
