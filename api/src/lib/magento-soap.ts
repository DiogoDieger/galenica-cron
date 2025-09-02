// src/lib/magento-soap.ts
import * as soap from "soap";

/**
 * Tipos de retorno usados pelos seus services.
 * Ajuste/expanda conforme necessário.
 */
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
  status?: string; // "1" habilitado, "2" desabilitado em Magento 1
  url_key?: string;
  url_path?: string;
  visibility?: string;
  category_ids?: string[];
  option_text_status?: string;
  required_options?: string;
  has_options?: string;
  image_label?: string;
  small_image_label?: string;
  thumbnail_label?: string;
  price?: string;
  special_price?: string;
  special_from_date?: string;
  special_to_date?: string;
  tax_class_id?: string;
  tier_price?: any[];
  meta_title?: string;
  meta_keyword?: string;
  meta_description?: string;
  custom_design?: string;
  custom_layout_update?: string;
  options_container?: string;
  additional_attributes?: any[];

  // Estoque
  qty?: string;
  is_in_stock?: string;
  min_qty?: string;
  max_qty?: string;

  // Customizados
  batch?: string;
  expiry_date?: string;
  manufacturer?: string;
  active_ingredient?: string;
  dosage?: string;
}

export interface CatalogProductRequestAttributes {
  attributes?: string[];
  additional_attributes?: string[];
}

/**
 * Cliente SOAP Magento (V2) — adaptado para seu projeto
 * Usa envs: MAGENTO_API_URL, MAGENTO_API_USER, MAGENTO_API_KEY
 */
class MagentoSoapClient {
  private wsdlUrl: string;
  private username: string;
  private apiKey: string;
  private sessionId: string | null = null;

  constructor() {
    const rawUrl = process.env.MAGENTO_API_URL ?? "";
    // aceita com ou sem ?wsdl
    this.wsdlUrl = rawUrl.includes("?wsdl") ? rawUrl : `${rawUrl}?wsdl`;
    this.username = process.env.MAGENTO_API_USER ?? "";
    this.apiKey = process.env.MAGENTO_API_KEY ?? "";

    if (!this.wsdlUrl || !this.username || !this.apiKey) {
      // Não estoura erro aqui para não quebrar o boot — os services tratam
      console.warn(
        "[magento-soap] Variáveis de ambiente ausentes ou incompletas."
      );
    }
  }

  private async createSoapClient(): Promise<soap.Client> {
    return new Promise((resolve, reject) => {
      soap.createClient(this.wsdlUrl, (err, client) => {
        if (err) return reject(err);
        resolve(client);
      });
    });
  }

  private async authenticate(): Promise<string> {
    if (this.sessionId) return this.sessionId;

    const client = await this.createSoapClient();
    return new Promise((resolve, reject) => {
      // Em Magento SOAP V2, método "login" existe no proxy gerado.
      // Alguns WSDLs expõem login(username, apiKey) diretamente.
      (client as any).login(
        this.username,
        this.apiKey,
        (err: any, result: any) => {
          if (err) return reject(err);
          this.sessionId = typeof result === "string" ? result : result?.result;
          if (!this.sessionId)
            return reject(new Error("Falha ao obter sessionId"));
          resolve(this.sessionId);
        }
      );
    });
  }

  /**
   * Helper genérico para chamar método V2 com assinatura (sessionId, ...args).
   * Observação: alguns WSDLs expõem "client[method]" diretamente,
   * outros exigem "client.call" estilo V1. Abaixo lidamos com ambos.
   */
  private async v2Call(method: string, args: any[]): Promise<any> {
    const client = await this.createSoapClient();
    const sessionId = await this.authenticate();

    // 1) Tentativa V2 direta
    if (typeof (client as any)[method] === "function") {
      return new Promise((resolve, reject) => {
        (client as any)[method](sessionId, ...args, (err: any, result: any) => {
          if (err) return reject(err);
          resolve(result?.result ?? result);
        });
      });
    }

    // 2) Fallback estilo V1 (client.call)
    if (typeof (client as any).call === "function") {
      return new Promise((resolve, reject) => {
        (client as any).call(
          method,
          [sessionId, ...args],
          (err: any, result: any) => {
            if (err) return reject(err);
            resolve(result?.result ?? result);
          }
        );
      });
    }

    throw new Error(`Método SOAP não encontrado: ${method}`);
  }

  // ---------- Métodos públicos usados pelos seus services ----------

  async catalogInventoryStockItemUpdate(
    productId: string,
    data: any
  ): Promise<any> {
    return this.v2Call("catalogInventoryStockItemUpdate", [productId, data]);
  }

  async catalogProductInfo(
    productId: string,
    storeView?: string,
    attributes?: CatalogProductRequestAttributes,
    identifierType: "id" | "sku" = "id"
  ): Promise<CatalogProductReturnEntity> {
    return this.v2Call("catalogProductInfo", [
      productId,
      storeView,
      attributes,
      identifierType,
    ]);
  }

  async catalogProductList(
    storeView?: string,
    filters?: any
  ): Promise<CatalogProductReturnEntity[]> {
    // Em muitos WSDLs, o segundo arg é "filters" — storeView pode ser undefined
    // Mantemos a assinatura que você já usa nos serviços.
    const result = await this.v2Call("catalogProductList", [
      storeView,
      filters,
    ]);
    // Normaliza array
    if (Array.isArray(result)) return result as CatalogProductReturnEntity[];
    if (result && Array.isArray(result?.item)) return result.item;
    return [];
  }

  /**
   * Busca estoque em lote (quando o WSDL suporta array de IDs) — método v2:
   * catalogInventoryStockItemList(sessionId, productIds: string[])
   */
  async getStockInfo(productIds: string[]): Promise<Record<string, any>> {
    const out: Record<string, any> = {};
    if (!productIds?.length) return out;

    try {
      const result = await this.v2Call("catalogInventoryStockItemList", [
        productIds,
      ]);

      // Alguns WSDLs retornam { item: [...] }, outros já retornam array
      const arr = Array.isArray(result)
        ? result
        : Array.isArray(result?.item)
        ? result.item
        : [];
      for (const row of arr) {
        // Normalmente vem com product_id, qty, is_in_stock, etc
        const pid = String(row?.product_id ?? row?.productId ?? "");
        if (pid) out[pid] = row;
      }
    } catch (e) {
      // Fallback: se o WSDL não aceitar array, chamar 1 a 1
      for (const pid of productIds) {
        try {
          const r = await this.v2Call("catalogInventoryStockItemList", [pid]);
          // quando chamada unitária, pode voltar objeto direto
          out[pid] = Array.isArray(r) ? r[0] : r?.item ? r.item[0] : r;
        } catch (err) {
          console.error(
            `[magento-soap] Falha ao buscar estoque do produto ${pid}:`,
            (err as any)?.message
          );
          out[pid] = null;
        }
      }
    }

    return out;
  }
}

// Singleton
export const magentoSoapClient = new MagentoSoapClient();
