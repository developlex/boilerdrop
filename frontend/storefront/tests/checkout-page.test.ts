import test from "node:test";
import assert from "node:assert/strict";
import { getCheckoutUiState } from "@/app/checkout/page";
import type { CheckoutReadiness } from "@/src/lib/commerce/types";

function createReadiness(overrides: Partial<CheckoutReadiness>): CheckoutReadiness {
  return {
    ready: false,
    reasons: [],
    isVirtual: false,
    requiresGuestEmail: true,
    selectedShippingMethod: null,
    availablePaymentMethods: [],
    availableShippingMethods: [],
    ...overrides
  };
}

test("getCheckoutUiState disables placement when no shipping methods are available", () => {
  const readiness = createReadiness({
    reasons: [
      "No shipping methods are currently available.",
      "Shipping method is not selected yet.",
      "Guest email is required before placing order."
    ],
    availablePaymentMethods: [{ code: "checkmo", title: "Check / Money order" }]
  });

  const uiState = getCheckoutUiState(readiness, true);
  assert.equal(uiState.hasMissingShippingMethods, true);
  assert.equal(uiState.hasMissingPaymentMethods, false);
  assert.equal(uiState.canPlaceOrder, false);
  assert.ok(uiState.visibleReadinessReasons.includes("No shipping methods are currently available."));
  assert.ok(uiState.visibleReadinessReasons.includes("Shipping method is not selected yet."));
  assert.equal(uiState.visibleReadinessReasons.includes("Guest email is required before placing order."), false);
});

test("getCheckoutUiState allows placement when shipping and payment methods are available", () => {
  const readiness = createReadiness({
    reasons: ["Shipping method is not selected yet."],
    selectedShippingMethod: null,
    availableShippingMethods: [
      {
        carrierCode: "flatrate",
        methodCode: "flatrate",
        carrierTitle: "Flat Rate",
        methodTitle: "Fixed",
        amount: 10,
        currency: "USD"
      }
    ],
    availablePaymentMethods: [{ code: "checkmo", title: "Check / Money order" }]
  });

  const uiState = getCheckoutUiState(readiness, false);
  assert.equal(uiState.hasMissingShippingMethods, false);
  assert.equal(uiState.hasMissingPaymentMethods, false);
  assert.equal(uiState.canPlaceOrder, true);
  assert.deepEqual(uiState.visibleReadinessReasons, []);
});
