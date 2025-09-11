// api/src/services/syncAllCustomers.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MAGENTO_SOAP_URL = process.env.MAGENTO_API_URL!;
const MAGENTO_API_USER = process.env.MAGENTO_API_USER!;
const MAGENTO_API_KEY = process.env.MAGENTO_API_KEY!;

interface CustomerEntity {
  customer_id: string;
  created_at: string;
  updated_at: string;
  increment_id: string;
  store_id: string;
  website_id: string;
  created_in: string;
  email: string;
  firstname: string;
  middlename?: string;
  lastname: string;
  group_id: string;
  prefix?: string;
  suffix?: string;
  dob?: string;
  taxvat?: string;
  confirmation?: string;
}

export async function syncAllCustomersJob() {
  console.log("=== INICIANDO SINCRONIZAÇÃO COMPLETA DE TODOS OS CUSTOMERS ===");
  const startTime = Date.now();

  try {
    const sessionId = await getMagentoSession();
    console.log("✅ Sessão Magento obtida com sucesso");

    const allCustomers = await getAllCustomersFromMagento(sessionId);
    console.log(`📊 Total de ${allCustomers.length} clientes encontrados`);

    const savedCustomers = await syncAllCustomersToDatabase(allCustomers);
    console.log(`💾 ${savedCustomers.length} clientes sincronizados no banco`);

    console.log(`⏱️ Tempo total: ${(Date.now() - startTime) / 1000}s`);
  } catch (err) {
    console.error("❌ Erro na sincronização completa de customers:", err);
  }
}

// ====================== Funções auxiliares ======================

async function getMagentoSession(): Promise<string> {
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

  const resp = await fetch(MAGENTO_SOAP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "urn:Magento#login",
    },
    body: xml,
  });

  const text = await resp.text();

  const patterns = [
    /<[^:>]*:?loginReturn[^>]*>([\s\S]*?)<\/[^:>]*:?loginReturn>/,
    /<result[^>]*>([\s\S]*?)<\/result>/,
    />([A-Za-z0-9]+)</,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1] && m[1].length > 10) return m[1];
  }

  throw new Error("Não foi possível extrair sessionId do login SOAP");
}

async function getAllCustomersFromMagento(
  sessionId: string
): Promise<CustomerEntity[]> {
  console.log("🔄 Buscando clientes do Magento...");

  // calcula a data/hora de 24h atrás
  const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19) // YYYY-MM-DDTHH:mm:ss
    .replace("T", " "); // Magento espera espaço

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:ns1="urn:Magento"
        xmlns:xsd="http://www.w3.org/2001/XMLSchema"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"
        SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
        <SOAP-ENV:Body>
          <ns1:customerCustomerList>
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
          </ns1:customerCustomerList>
        </SOAP-ENV:Body>
      </SOAP-ENV:Envelope>`;

  const resp = await fetch(MAGENTO_SOAP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "urn:Magento#customerCustomerList",
    },
    body: xml,
  });

  const text = await resp.text();

  return parseCustomersXml(text);
}

function parseCustomersXml(xml: string): CustomerEntity[] {
  //   console.log(xml, "XML");
  const customers: CustomerEntity[] = [];
  const matches = xml.match(/<item[^>]*>([\s\S]*?)<\/item>/g) || [];

  for (const m of matches) {
    const extract = (tag: string) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i");
      const match = m.match(re);
      return match ? match[1].trim() : null;
    };
    const customer_id = extract("customer_id");
    const email = extract("email");

    if (customer_id && email) {
      customers.push({
        customer_id,
        created_at: extract("created_at") || "",
        updated_at: extract("updated_at") || "",
        increment_id: extract("increment_id") || "",
        store_id: extract("store_id") || "",
        website_id: extract("website_id") || "",
        created_in: extract("created_in") || "",
        email,
        firstname: extract("firstname") || "",
        lastname: extract("lastname") || "",
        group_id: extract("group_id") || "",
      });
    }
  }

  return customers;
}

async function syncAllCustomersToDatabase(customers: CustomerEntity[]) {
  const saved: any[] = [];

  for (let i = 0; i < customers.length; i++) {
    const customer = customers[i];
    console.log(customer, "CUSTOMER");
    console.log(i, "INDEX");
    try {
      const savedCustomer = await prisma.customer.upsert({
        where: { customerId: customer.customer_id },
        update: {
          email: customer.email,
          firstname: customer.firstname,
          lastname: customer.lastname,
          groupId: customer.group_id || null,
          createdAt: customer.created_at
            ? new Date(customer.created_at)
            : new Date(),
          syncedAt: new Date(),
        },
        create: {
          customerId: customer.customer_id,
          email: customer.email,
          firstname: customer.firstname,
          lastname: customer.lastname,
          groupId: customer.group_id || null,
          createdAt: customer.created_at
            ? new Date(customer.created_at)
            : new Date(),
          syncedAt: new Date(),
        },
      });
      saved.push(savedCustomer);
    } catch (e) {
      console.error(`❌ Erro ao salvar cliente ${customer.customer_id}:`, e);
    }
  }

  return saved;
}
