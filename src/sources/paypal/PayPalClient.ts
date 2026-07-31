/**
 * Minimal PayPal REST client: OAuth2 client-credentials plus the Transaction
 * Search endpoint. Written against `fetch` rather than pulling in the PayPal SDK,
 * which is large and mostly concerned with checkout flows we do not use.
 */

import { UpstreamConfigError, UpstreamUnavailableError } from '../../errors.js';
import { logger } from '../../logger.js';

export const PAYPAL_SOURCE = 'paypal';

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const LIVE_BASE = 'https://api-m.paypal.com';

/** Transaction Search rejects windows wider than 31 days. */
export const MAX_WINDOW_DAYS = 31;

/** Shape of the fields we read from `transaction_info`. */
export interface PayPalTransactionInfo {
  transaction_id?: string;
  transaction_status?: string;
  transaction_amount?: { currency_code?: string; value?: string };
  transaction_initiation_date?: string;
  transaction_updated_date?: string;
}

export interface PayPalTransaction {
  transaction_info?: PayPalTransactionInfo;
}

export interface TransactionPage {
  transaction_details: PayPalTransaction[];
  page: number;
  total_pages: number;
}

export class PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly baseUrl: string = SANDBOX_BASE,
  ) {}

  static fromEnv(): PayPalClient {
    const id = process.env.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_CLIENT_SECRET;
    if (!id || !secret) {
      throw new UpstreamConfigError(
        PAYPAL_SOURCE,
        'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must both be set',
      );
    }
    // Sandbox by default. Going live has to be an explicit, visible choice.
    const live = process.env.PAYPAL_ENV === 'live';
    if (live) {
      logger.warn({ source: PAYPAL_SOURCE }, 'PAYPAL_ENV=live — using production PayPal');
    }
    return new PayPalClient(id, secret, live ? LIVE_BASE : SANDBOX_BASE);
  }

  /** Cached access token, refreshed a minute before it actually expires. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (cause) {
      throw new UpstreamUnavailableError(PAYPAL_SOURCE, cause);
    }

    if (res.status === 401 || res.status === 403) {
      throw new UpstreamConfigError(
        PAYPAL_SOURCE,
        'credentials rejected — check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET and that they match PAYPAL_ENV',
      );
    }
    if (!res.ok) {
      throw new UpstreamUnavailableError(PAYPAL_SOURCE, `token endpoint returned ${res.status}`);
    }

    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new UpstreamUnavailableError(PAYPAL_SOURCE, 'token response had no access_token');
    }

    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 300) - 60) * 1000,
    };
    return this.token.value;
  }

  /**
   * One page of the Transaction Search API.
   *
   * `start_date`/`end_date` are required, must be ISO-8601 with an offset, and
   * must be no more than 31 days apart — the caller is responsible for windowing.
   */
  async listTransactions(params: {
    startDate: Date;
    endDate: Date;
    page: number;
    pageSize: number;
  }): Promise<TransactionPage> {
    const token = await this.accessToken();

    const query = new URLSearchParams({
      start_date: params.startDate.toISOString(),
      end_date: params.endDate.toISOString(),
      fields: 'transaction_info',
      page_size: String(params.pageSize),
      page: String(params.page),
    });

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/reporting/transactions?${query}`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (cause) {
      throw new UpstreamUnavailableError(PAYPAL_SOURCE, cause);
    }

    if (res.status === 401 || res.status === 403) {
      // 403 here usually means the app exists but Transaction Search was never
      // enabled on it — a config problem, not an outage, so retrying is pointless.
      throw new UpstreamConfigError(
        PAYPAL_SOURCE,
        `Transaction Search returned ${res.status}. Enable the "Transaction Search" ` +
          'feature on your PayPal REST app, then regenerate credentials.',
      );
    }
    if (res.status === 400) {
      const detail = await res.text().catch(() => '');
      throw new UpstreamConfigError(
        PAYPAL_SOURCE,
        `Transaction Search rejected the request: ${detail.slice(0, 300)}`,
      );
    }
    if (res.status === 404) {
      // MEASURED, 2026-07-31 sandbox: Transaction Search answers 404
      // INVALID_REQUEST "Data for the given start date is not available." for any
      // start_date newer than roughly now-2h — its reporting horizon. That is
      // "nothing has settled that recently", not an outage, and returning 503
      // turned an ordinary sync into a failed one.
      //
      // PayPalAdapter already keeps its windows behind the horizon so this should
      // not be reached; it survives as a backstop for clock skew between this
      // process and PayPal, where a window can be a few seconds too fresh. Any
      // OTHER 404 is still a real error.
      const detail = await res.text().catch(() => '');
      if (/data for the given start date is not available/i.test(detail)) {
        logger.info(
          { source: PAYPAL_SOURCE, startDate: params.startDate.toISOString() },
          'start_date is inside PayPal\'s reporting horizon; treating as no data yet',
        );
        return { transaction_details: [], page: params.page, total_pages: 0 };
      }
      throw new UpstreamUnavailableError(
        PAYPAL_SOURCE,
        `Transaction Search returned 404: ${detail.slice(0, 300)}`,
      );
    }
    if (!res.ok) {
      throw new UpstreamUnavailableError(PAYPAL_SOURCE, `Transaction Search returned ${res.status}`);
    }

    const body = (await res.json()) as Partial<TransactionPage>;
    return {
      transaction_details: body.transaction_details ?? [],
      page: body.page ?? params.page,
      total_pages: body.total_pages ?? 1,
    };
  }
}
