import { z } from "zod";

// Capital One Nessie sandbox (fake customers, fake money). The official
// /documentation and swagger pages return 403, so these shapes come from the
// historical API and from 2026 hackathon reports:
//   - POST /accounts/{id}/transfers rejects payee_id and medium, so moving
//     money between members is a withdrawal on the payer plus a deposit on
//     the payee.
//   - Account balances never change after creation; we track adjustments in
//     our own ledger (see bank/index.ts).
//   - Amounts are truncated to whole dollars.
//   - Deposits (and the withdrawals' reads) require `status`; "completed" works.
//   - Plain http:// is refused; use https://api.nessieisreal.com.
// Run `npm run seed:nessie -- --check` with a real key to verify before the demo.

const createdSchema = z.object({
  objectCreated: z.object({ _id: z.string() }).passthrough(),
});
const accountSchema = z
  .object({ _id: z.string(), balance: z.number(), nickname: z.string().optional(), customer_id: z.string().optional() })
  .passthrough();

export class NessieError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Nessie ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = "NessieError";
  }
}

export class NessieClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("key", this.apiKey);
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    // Never include the URL in errors: it carries the API key.
    if (!res.ok) throw new NessieError(res.status, path, text);
    return text ? JSON.parse(text) : undefined;
  }

  async createCustomer(firstName: string, lastName: string): Promise<string> {
    const res = await this.request("POST", "/customers", {
      first_name: firstName,
      last_name: lastName,
      address: { street_number: "1", street_name: "Massachusetts Ave", city: "Cambridge", state: "MA", zip: "02138" },
    });
    return createdSchema.parse(res).objectCreated._id;
  }

  async createAccount(customerId: string, nickname: string, balance: number): Promise<string> {
    const res = await this.request("POST", `/customers/${encodeURIComponent(customerId)}/accounts`, {
      type: "Checking",
      nickname,
      rewards: 0,
      balance: Math.trunc(balance),
    });
    return createdSchema.parse(res).objectCreated._id;
  }

  async getAccount(accountId: string): Promise<z.infer<typeof accountSchema>> {
    return accountSchema.parse(await this.request("GET", `/accounts/${encodeURIComponent(accountId)}`));
  }

  withdraw(accountId: string, amount: number, description: string): Promise<string> {
    return this.postTransaction(`/accounts/${encodeURIComponent(accountId)}/withdrawals`, amount, description);
  }

  deposit(accountId: string, amount: number, description: string): Promise<string> {
    return this.postTransaction(`/accounts/${encodeURIComponent(accountId)}/deposits`, amount, description);
  }

  /**
   * The historical API requires `medium`; reports say parts of the 2026
   * sandbox reject it. Try the documented body first and retry once without
   * `medium` on a 400.
   */
  private async postTransaction(path: string, amount: number, description: string): Promise<string> {
    const base = {
      amount: Math.trunc(amount),
      description,
      transaction_date: new Date().toISOString().slice(0, 10),
      status: "completed",
    };
    try {
      return createdSchema.parse(await this.request("POST", path, { medium: "balance", ...base })).objectCreated._id;
    } catch (err) {
      if (!(err instanceof NessieError) || err.status !== 400) throw err;
      return createdSchema.parse(await this.request("POST", path, base)).objectCreated._id;
    }
  }
}
