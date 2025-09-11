// api/src/services/updateAddres.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MAGENTO_SOAP_URL = process.env.MAGENTO_API_URL ?? ""; // ex.: https://gfarma.lionsuite.com.br/api/v2_soap
const MAGENTO_API_USER = process.env.MAGENTO_API_USER ?? "";
const MAGENTO_API_KEY = process.env.MAGENTO_API_KEY ?? ""; // compat

type MagentoAddress = {
  customer_address_id?: string;
  created_at?: string;
  updated_at?: string;
  city?: string;
  company?: string;
  country_id?: string;
  fax?: string;
  firstname?: string;
  lastname?: string;
  middlename?: string;
  postcode?: string;
  prefix?: string;
  region?: string;
  region_id?: string;
  street?: string;
  suffix?: string;
  telephone?: string;
  is_default_billing?: string | boolean;
  is_default_shipping?: string | boolean;
};

export interface UpdateAddressInput {
  shippingAddressId: string | number;
  updateAllWithSameId?: boolean; // mantido para compat; hoje atualizamos por addressId
}

export interface UpdateAddressResult {
  ok: boolean;
  shipping_address_id: string;
  updated_count: number;
  address: MagentoAddress;
}

function requiredEnv() {
  if (!MAGENTO_SOAP_URL || !MAGENTO_API_USER || !MAGENTO_API_KEY) {
    throw new Error("Credenciais/URL do Magento não configuradas");
  }
}

function extractTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : undefined;
}

function normalizeBool(v?: string | boolean): boolean | null {
  if (typeof v === "boolean") return v;
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return null;
}

function splitStreet(street?: string) {
  if (!street) return { line1: null, line2: null, line3: null, line4: null };
  const lines = street
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    line1: lines[0] ?? null,
    line2: lines[1] ?? null,
    line3: lines[2] ?? null,
    line4: lines[3] ?? null,
  };
}

async function getMagentoSession(): Promise<string> {
  const loginRequest = `<?xml version="1.0" encoding="UTF-8"?>
  <SOAP-ENV:Envelope 
    xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
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

  const resp = await fetch(MAGENTO_SOAP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "urn:Magento#login",
    },
    body: loginRequest,
  });

  const text = await resp.text();
  if (!resp.ok || /<faultstring>/.test(text)) {
    const msg =
      text.match(/<faultstring>([\s\S]*?)<\/faultstring>/)?.[1] ??
      `HTTP ${resp.status}`;
    throw new Error(`Falha no login SOAP: ${msg}`);
  }

  const patterns = [
    /<[^:>]*:?loginReturn[^>]*>([\s\S]*?)<\/[^:>]*:?loginReturn>/,
    /<result[^>]*>([\s\S]*?)<\/result>/,
    />\s*([a-f0-9]{20,})\s*<\/[^>]*>/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }
  throw new Error("Não foi possível extrair sessionId do login SOAP");
}

async function getCustomerAddressInfo(
  sessionId: string,
  addressId: string | number
): Promise<MagentoAddress> {
  console.log(sessionId, addressId);
  const req = `<?xml version="1.0" encoding="UTF-8"?>
  <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:Magento">
    <soapenv:Body>
      <urn:customerAddressInfo>
        <sessionId>${sessionId}</sessionId>
        <addressId>${addressId}</addressId>
      </urn:customerAddressInfo>
    </soapenv:Body>
  </soapenv:Envelope>`;

  const resp = await fetch(MAGENTO_SOAP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "urn:Magento#customerAddressInfo",
    },
    body: req,
  });

  const text = await resp.text();
  if (!resp.ok || /<faultstring>/.test(text)) {
    const msg =
      text.match(/<faultstring>([\s\S]*?)<\/faultstring>/)?.[1] ??
      `HTTP ${resp.status}`;
    throw new Error(`Erro em customerAddressInfo: ${msg}`);
  }

  const blockMatch = text.match(/<info[^>]*>([\s\S]*?)<\/info>/i);
  const block = blockMatch ? blockMatch[1] : text;
  console.log(text);
  const addr: MagentoAddress = {
    customer_address_id: extractTag(block, "customer_address_id"),
    created_at: extractTag(block, "created_at"),
    updated_at: extractTag(block, "updated_at"),
    city: extractTag(block, "city"),
    company: extractTag(block, "company"),
    country_id: extractTag(block, "country_id"),
    fax: extractTag(block, "fax"),
    firstname: extractTag(block, "firstname"),
    lastname: extractTag(block, "lastname"),
    middlename: extractTag(block, "middlename"),
    postcode: extractTag(block, "postcode"),
    prefix: extractTag(block, "prefix"),
    region: extractTag(block, "region"),
    region_id: extractTag(block, "region_id"),
    street: extractTag(block, "street"),
    suffix: extractTag(block, "suffix"),
    telephone: extractTag(block, "telephone"),
    is_default_billing: extractTag(block, "is_default_billing"),
    is_default_shipping: extractTag(block, "is_default_shipping"),
  };

  return addr;
}

// ... (arquivo igual acima até chegar na função updateAddressAndSyncOrders)

/**
 * Atualiza os pedidos locais com base no shipping_address_id vindo do Magento.
 * - Gera sessionId novo a cada chamada.
 * - Busca address via customerAddressInfo.
 * - Atualiza todos os pedidos onde Order.shippingAddressId == shippingAddressId.
 */
export async function updateAddressAndSyncOrders(
  input: UpdateAddressInput
): Promise<UpdateAddressResult> {
  requiredEnv();

  const shippingAddressId = String(input.shippingAddressId);

  // 1) login
  const sessionId = await getMagentoSession();

  // 2) busca endereço
  const addr = await getCustomerAddressInfo(sessionId, shippingAddressId);

  // 3) normaliza + mapeia campos para a sua tabela Order (rua em UMA linha)
  const streetLines = splitStreet(addr.street);
  const streetJoined = [
    streetLines.line1,
    streetLines.line2,
    streetLines.line3,
    streetLines.line4,
  ]
    .filter(Boolean)
    .join(", ");
  const isDefaultBilling = normalizeBool(addr.is_default_billing);
  const isDefaultShipping = normalizeBool(addr.is_default_shipping);

  const dataToSet: any = {
    shippingFirstname: addr.firstname ?? null,
    shippingLastname: addr.lastname ?? null,
    shippingCompany: addr.company ?? null,
    shippingStreet: streetJoined || null,
    shippingCity: addr.city ?? null,
    shippingRegion: addr.region ?? null,
    shippingRegionId: addr.region_id ? Number(addr.region_id) : null,
    shippingPostcode: addr.postcode ?? null,
    shippingCountryId: addr.country_id ?? null,
    shippingTelephone: addr.telephone ?? null,
    shippingIsDefaultBilling: isDefaultBilling,
    shippingIsDefaultShipping: isDefaultShipping,
    shippingAddressUpdatedAt: new Date(),
  };

  // 4) atualiza pedidos com o mesmo shippingAddressId
  const result = await prisma.order.updateMany({
    where: { shippingAddressId: shippingAddressId },
    data: dataToSet,
  });

  return {
    ok: true,
    shipping_address_id: shippingAddressId,
    updated_count: result.count,
    address: addr,
  };
}

/**
 * Cron single-session:
 * - Gera UM sessionId
 * - Coleta todos os shippingAddressId distintos (não nulos)
 * - Para cada addressId, chama customerAddressInfo reutilizando a mesma sessão
 * - Atualiza todos os pedidos de cada addressId
 */
export async function syncAllOrdersShippingAddressesSingleSession(options?: {
  onlyMissing?: boolean; // default: true -> atualiza só quem está faltando/dados vazios
  updatedBefore?: Date; // se informado, atualiza somente registros anteriores a essa data
  concurrency?: number; // default: 5
  retries?: number; // default: 2
}) {
  console.log("TESTE 2");
  requiredEnv();
  const {
    onlyMissing = false,
    updatedBefore,
    concurrency = 5,
    retries = 2,
  } = options ?? {};

  const sessionId = await getMagentoSession();

  console.log("TESTE 3", sessionId);

  // 2) pegar IDs distintos
  const groups = await prisma.order.groupBy({
    by: ["shippingAddressId"],
    where: {
      shippingAddressId: { not: null },
      ...(onlyMissing
        ? {
            OR: [
              { shippingStreet: null },
              { shippingCity: null },
              { shippingRegion: null },
              { shippingPostcode: null },
              { shippingCountryId: null },
              { shippingTelephone: null },
              { shippingCompany: null },
              { shippingIsDefaultBilling: null },
              { shippingIsDefaultShipping: null },
              ...(updatedBefore
                ? [{ shippingAddressUpdatedAt: { lt: updatedBefore } }]
                : []),
            ],
          }
        : updatedBefore
        ? { shippingAddressUpdatedAt: { lt: updatedBefore } }
        : {}),
    },
    _count: { _all: true },
  });

  console.log("TESTE 4", groups);

  const ids = groups
    .map((g) => g.shippingAddressId)
    .filter((v): v is string => !!v);
  if (ids.length === 0) {
    return {
      ok: true,
      totalDistinctIds: 0,
      updatedIds: 0,
      updatedOrders: 0,
      errors: [] as any[],
    };
  }

  // mini p-limit
  const pLimit = <T>(n: number) => {
    let running = 0;
    const queue: Array<() => void> = [];
    const run = async <R>(fn: () => Promise<R>) =>
      new Promise<R>((resolve, reject) => {
        const exec = () => {
          running++;
          fn()
            .then(resolve)
            .catch(reject)
            .finally(() => {
              running--;
              if (queue.length) queue.shift()!();
            });
        };
        running < n ? exec() : queue.push(exec);
      });
    return async <R>(fn: () => Promise<R>) => run(fn);
  };
  const limit = pLimit(concurrency);

  let updatedIds = 0;
  let updatedOrders = 0;
  const errors: Array<{ shippingAddressId: string; error: string }> = [];

  const tasks = ids.map((id) =>
    limit(async () => {
      let attempt = 0;
      while (true) {
        try {
          // busca endereço com a MESMA sessão
          const addr = await getCustomerAddressInfo(sessionId, id);

          const streetLines = splitStreet(addr.street);
          const streetJoined = [
            streetLines.line1,
            streetLines.line2,
            streetLines.line3,
            streetLines.line4,
          ]
            .filter(Boolean)
            .join(", ");
          const isDefaultBilling = normalizeBool(addr.is_default_billing);
          const isDefaultShipping = normalizeBool(addr.is_default_shipping);

          const dataToSet: any = {
            shippingFirstname: addr.firstname ?? null,
            shippingLastname: addr.lastname ?? null,
            shippingCompany: addr.company ?? null,
            shippingStreet: streetJoined || null,
            shippingCity: addr.city ?? null,
            shippingRegion: addr.region ?? null,
            shippingRegionId: addr.region_id ? Number(addr.region_id) : null,
            shippingPostcode: addr.postcode ?? null,
            shippingCountryId: addr.country_id ?? null,
            shippingTelephone: addr.telephone ?? null,
            shippingIsDefaultBilling: isDefaultBilling,
            shippingIsDefaultShipping: isDefaultShipping,
            shippingAddressUpdatedAt: new Date(),
          };

          const u = await prisma.order.updateMany({
            where: { shippingAddressId: id },
            data: dataToSet,
          });

          updatedIds++;
          updatedOrders += u.count;
          return;
        } catch (e: any) {
          attempt++;
          if (attempt > retries) {
            errors.push({
              shippingAddressId: id,
              error: e?.message || String(e),
            });
            return;
          }
          await new Promise((r) => setTimeout(r, 300 * attempt * attempt)); // backoff
        }
      }
    })
  );

  await Promise.allSettled(tasks);

  return {
    ok: errors.length === 0,
    totalDistinctIds: ids.length,
    updatedIds,
    updatedOrders,
    errors,
  };
}
