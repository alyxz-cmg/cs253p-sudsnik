import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractSuite } from "@sudsnik/contracts/testing/contractSuite";
import { routes } from "@sudsnik/contracts/services/billing";
import { createApp, handlersDir } from "../../src/index.js";

contractSuite(
  { describe, it, expect, beforeAll, afterAll },
  {
    service: "billing",
    routes,
    createApp,
    handlersDir,
    examples: {
      quote: { params: { orderId: "ord1" } },
      authorize: { body: { orderId: "ord1", amount: 4900, currency: "USD", callbackUrl: "http://localhost/cb" } },
      capture: { params: { orderId: "ord1" } },
      refund: { params: { orderId: "ord1" } },
      ledger: { query: { limit: "10" } },
      paymentsWebhook: { body: { id: "ev1", paymentRef: "pref1", orderId: "ord1", event: "captured", amount: 4900, currency: "USD", atMs: 1000 } }
    },
  },
);