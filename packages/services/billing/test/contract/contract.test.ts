import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { routes } from "@sudsnik/contracts/services/billing";
import { contractSuite } from "@sudsnik/contracts/testing/contractSuite";
import { serviceDataFile } from "@sudsnik/infra-boot";
import { openDb } from "@sudsnik/infra-db";
import { migrationsDir, createApp, handlersDir } from "../../src/index.js";

const SEEDED_ORDER = "contract-order";

contractSuite(
  { describe, it, expect, beforeAll, afterAll },
  {
    service: "billing",
    routes,
    createApp,
    handlersDir,
    examples: {
      quote: {
        params: { orderId: SEEDED_ORDER },
      },
      authorize: {
        headers: { "idempotency-key": "contract-auth-key-1" },
        body: {
          orderId: SEEDED_ORDER,
          amount: 4900,
          currency: "USD",
        },
      },
      capture: {
        headers: { "idempotency-key": "contract-cap-key-1" },
        params: { orderId: SEEDED_ORDER },
      },
      refund: {
        headers: { "idempotency-key": "contract-ref-key-1" },
        params: { orderId: SEEDED_ORDER },
        body: { amount: 4900, currency: "USD" },
      },
      ledger: {
        query: { orderId: SEEDED_ORDER, limit: "10" },
      },
      paymentsWebhook: {
        body: {
          id: "evt_contract_01",
          paymentRef: "pay_contract_ref_01",
          orderId: SEEDED_ORDER,
          event: "captured",
          amount: 4900,
          currency: "USD",
        },
      },
    } as any,
    prepare(deps) {
      const db = openDb({
        path: serviceDataFile(deps),
        service: deps.service,
        meter: deps.meter,
        migrationsDir,
      });

      const now = Date.now();

      db.write(
        "insert into operators (operator_id, pricing_tier, region, currency, created_at) values (?, ?, ?, ?, ?)",
        "contract-tenant",
        "standard",
        "us-west",
        "USD",
        now,
      );

      db.write(
        "insert into washes (order_id, cycle_units, created_at) values (?, ?, ?)",
        SEEDED_ORDER,
        2,
        now,
      );

      db.write(
        "insert into charges (charge_id, order_id, tenant_id, payment_ref, state, amount, currency, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        "chg_seeded_contract",
        SEEDED_ORDER,
        "contract-tenant",
        "pay_seeded_ref",
        "authorized",
        4900,
        "USD",
        now,
      );

      db.write(
        "insert into ledger (id, tenant_id, order_id, kind, amount, currency, at, ref) values (?, ?, ?, ?, ?, ?, ?, ?)",
        "led_seeded_contract",
        "contract-tenant",
        SEEDED_ORDER,
        "authorize",
        4900,
        "USD",
        now,
        "pay_seeded_ref",
      );

      db.close();
    },
  },
);