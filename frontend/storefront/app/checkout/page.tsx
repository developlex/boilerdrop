import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { placeOrderAction } from "@/app/actions/checkout";
import { getCart, getCheckoutReadiness, setGuestEmailOnCart, setShippingAddressOnCart, setShippingMethodOnCart } from "@/src/lib/commerce/cart";
import { getCustomerDashboard, getCustomerProfile } from "@/src/lib/commerce/customer";
import { getCountryRegions } from "@/src/lib/commerce/directory";
import { dedupeUsStateOptions, US_COUNTRY_CODE, US_COUNTRY_LABEL, US_STATE_OPTIONS } from "@/src/lib/forms/us-states";
import { readCartCookie, readCustomerTokenCookie } from "@/src/lib/session-cookies";
import type { CheckoutReadiness, CustomerAddress } from "@/src/lib/commerce/types";
import { ui } from "@/src/ui/styles";

export const metadata: Metadata = {
  title: "Checkout | BoilerDrop Storefront",
  robots: {
    index: false,
    follow: false
  }
};

type SearchParams = {
  checkout?: string | string[];
  reason?: string | string[];
};

type StateOption = {
  code: string;
  name: string;
};

function parseAddressId(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveDefaultShippingAddress(addresses: CustomerAddress[], defaultShippingId: string | null): CustomerAddress | null {
  const parsedDefaultId = parseAddressId(defaultShippingId);
  if (parsedDefaultId !== null) {
    const byId = addresses.find((address) => Number(address.id) === parsedDefaultId);
    if (byId) {
      return byId;
    }
  }
  return addresses.find((address) => address.defaultShipping) ?? null;
}

function toShippingAddressInput(address: CustomerAddress) {
  const street = address.street.filter((line) => line.trim().length > 0);
  return {
    firstname: address.firstname,
    lastname: address.lastname,
    street: street.length > 0 ? street : [""],
    city: address.city,
    postcode: address.postcode,
    countryCode: address.countryCode,
    telephone: address.telephone,
    region: address.regionCode ?? address.region
  };
}

function getFirstValue(input: string | string[] | undefined): string | null {
  if (Array.isArray(input)) {
    return input[0] ?? null;
  }
  return typeof input === "string" ? input : null;
}

function getCheckoutNotice(searchParams: SearchParams | undefined): { type: "error"; message: string } | null {
  if (!searchParams) {
    return null;
  }

  const checkout = getFirstValue(searchParams.checkout);
  const reason = getFirstValue(searchParams.reason);
  if (checkout !== "error") {
    return null;
  }

  const byReason: Record<string, string> = {
    "missing-cart": "Cart session was not found. Add products before checkout.",
    "invalid-email": "Enter a valid email address before placing order.",
    "invalid-shipping-address": "Shipping address is required for physical products.",
    "missing-shipping-method": "Select a shipping method before placing order.",
    "invalid-shipping-method": "Selected shipping method is not available for this cart.",
    "missing-payment-method": "Select a payment method before placing order.",
    "cart-not-ready": "Cart is not ready for checkout yet. Resolve shipping/payment readiness first.",
    "checkout-failed": "Checkout failed in commerce backend. Review cart readiness and try again.",
    unexpected: "Unexpected checkout failure occurred. Please try again."
  };

  return { type: "error", message: byReason[reason ?? ""] ?? "Checkout failed. Please try again." };
}

export type CheckoutUiState = {
  visibleReadinessReasons: string[];
  hasMissingShippingMethods: boolean;
  hasMissingPaymentMethods: boolean;
  canPlaceOrder: boolean;
};

export function getCheckoutUiState(readiness: CheckoutReadiness, hasCustomerSession: boolean): CheckoutUiState {
  const hasMissingShippingMethods = !readiness.isVirtual && readiness.availableShippingMethods.length === 0;
  const hasMissingPaymentMethods = readiness.availablePaymentMethods.length === 0;
  const visibleReadinessReasons = readiness.reasons.filter((reason) => {
    if (hasCustomerSession && reason === "Guest email is required before placing order.") {
      return false;
    }
    if (!readiness.isVirtual && readiness.availableShippingMethods.length > 0 && reason === "Shipping method is not selected yet.") {
      return false;
    }
    return true;
  });

  return {
    visibleReadinessReasons,
    hasMissingShippingMethods,
    hasMissingPaymentMethods,
    canPlaceOrder: !hasMissingShippingMethods && !hasMissingPaymentMethods
  };
}

export default async function CheckoutPage({
  searchParams
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const checkoutNotice = getCheckoutNotice(resolvedSearchParams);
  const cookieStore = await cookies();
  const cartId = readCartCookie(cookieStore);
  const customerToken = readCustomerTokenCookie(cookieStore);
  let customerEmail: string | null = null;
  let defaultShippingAddress: CustomerAddress | null = null;
  if (customerToken) {
    try {
      const [customerProfile, dashboard] = await Promise.all([
        getCustomerProfile(customerToken),
        getCustomerDashboard(customerToken)
      ]);
      const normalizedEmail = customerProfile.email.trim().toLowerCase();
      customerEmail = normalizedEmail.length > 0 ? normalizedEmail : null;
      defaultShippingAddress = resolveDefaultShippingAddress(dashboard.addresses, dashboard.defaultShippingId);
    } catch {
      customerEmail = null;
      defaultShippingAddress = null;
    }
  }
  const hasCustomerSession = Boolean(customerEmail);

  if (!cartId) {
    return (
      <section className="mx-auto max-w-3xl">
        <h1 className={ui.text.pageTitle}>Checkout</h1>
        {checkoutNotice ? (
          <p className={ui.state.warning + " mt-4"}>{checkoutNotice.message}</p>
        ) : null}
        <p className={ui.text.subtitle + " mt-4"}>Your cart is empty. Add products before checkout.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/cart" className={ui.action.buttonSecondary}>View cart</Link>
          <Link href="/" className={ui.action.buttonSecondary}>Continue shopping</Link>
        </div>
      </section>
    );
  }

  let cart;
  let readiness;
  const storeRegions = await getCountryRegions(US_COUNTRY_CODE).catch(() => []);
  const stateOptions: StateOption[] = dedupeUsStateOptions(storeRegions.length > 0
    ? storeRegions.map((region) => ({ code: region.code, name: region.name }))
    : [...US_STATE_OPTIONS]);

  try {
    if (customerEmail) {
      await setGuestEmailOnCart(cartId, customerEmail);
    }
    if (defaultShippingAddress) {
      await setShippingAddressOnCart(cartId, toShippingAddressInput(defaultShippingAddress));
      const readinessAfterAddress = await getCheckoutReadiness(cartId);
      if (
        !readinessAfterAddress.isVirtual &&
        !readinessAfterAddress.selectedShippingMethod &&
        readinessAfterAddress.availableShippingMethods[0]
      ) {
        const firstMethod = readinessAfterAddress.availableShippingMethods[0];
        await setShippingMethodOnCart(cartId, {
          carrierCode: firstMethod.carrierCode,
          methodCode: firstMethod.methodCode
        });
      }
    }
    cart = await getCart(cartId);
    readiness = await getCheckoutReadiness(cartId);
  } catch {
    return (
      <section className="mx-auto max-w-3xl">
        <h1 className={ui.text.pageTitle}>Checkout</h1>
        <p className={ui.state.warning + " mt-4"}>
          Checkout data could not be loaded. Go back to cart and try again.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/cart" className={ui.action.buttonSecondary}>Back to cart</Link>
          <Link href="/" className={ui.action.buttonSecondary}>Continue shopping</Link>
        </div>
      </section>
    );
  }
  const checkoutUiState = getCheckoutUiState(readiness, hasCustomerSession);

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className={ui.text.pageTitle}>Checkout</h1>
        {!hasCustomerSession ? (
          <>
            <p className={ui.text.subtitle + " mt-2"}>
              Guest checkout is enabled. You can place an order without account creation.
            </p>
            <p className={ui.text.subtitle + " mt-1"}>
              Have an account?{" "}
              <Link href="/login" className={ui.text.link}>Sign in</Link>
              {" "}or{" "}
              <Link href="/register" className={ui.text.link}>create account</Link>
              {" "}later if needed.
            </p>
          </>
        ) : null}
      </header>

      {checkoutNotice ? (
        <p className={ui.state.warning}>{checkoutNotice.message}</p>
      ) : null}

      <section className={ui.surface.panel}>
        <h2 className={ui.text.value}>Order summary</h2>
        <p className={ui.text.subtitle + " mt-2"}>Items: {cart.totalQuantity}</p>
        <p className={ui.text.subtitle}>
          Grand total: {cart.grandTotal !== null && cart.currency ? `${cart.currency} ${cart.grandTotal.toFixed(2)}` : "Unavailable"}
        </p>
        <div className="mt-3">
          <Link href="/cart" className={ui.action.buttonSecondary}>Edit cart</Link>
        </div>
      </section>

      <section id="shipping" className={ui.surface.panel}>
        <h2 className={ui.text.value}>Shipping and payment</h2>
        <p className={ui.text.subtitle + " mt-2"}>
          Shipping selected: {readiness.isVirtual ? "Not required (virtual cart)" : readiness.selectedShippingMethod ? readiness.selectedShippingMethod : "No"}
        </p>
        <p className={ui.text.subtitle}>
          Payment methods available: {readiness.availablePaymentMethods.length}
        </p>

        {checkoutUiState.visibleReadinessReasons.length > 0 ? (
          <div className={ui.state.warning + " mt-3"}>
            <p className="font-medium">Checkout readiness notices:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {checkoutUiState.visibleReadinessReasons.map((reason: string) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {checkoutUiState.hasMissingShippingMethods ? (
          <div className={ui.state.warning + " mt-3"}>
            <p className="font-medium">No shipping methods are currently available for this cart.</p>
            <p className="mt-1 text-sm">
              Verify shipping address details or return to cart and try again.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/cart" className={ui.action.buttonSecondary}>Back to cart</Link>
              <Link href="/account/addresses" className={ui.action.buttonSecondary}>Manage addresses</Link>
            </div>
          </div>
        ) : null}

        <form action={placeOrderAction} className="mt-4 space-y-3">
          {hasCustomerSession && customerEmail ? (
            <div className="space-y-1">
              <p className={ui.text.label}>Account email</p>
              <p className={ui.text.subtitle}>{customerEmail}</p>
              <input type="hidden" name="email" value={customerEmail} />
            </div>
          ) : (
            <label className="block text-sm">
              <span className={ui.text.label + " mb-1 block"}>Email *</span>
              <input name="email" type="email" required className={ui.form.input} placeholder="name@example.com" />
            </label>
          )}

          {!readiness.isVirtual ? (
            <div className="space-y-3">
              <p className={ui.text.label}>Shipping address</p>
              <label className="block text-sm">
                <span className={ui.text.label + " mb-1 block"}>First name *</span>
                <input
                  name="shipping_firstname"
                  type="text"
                  required={!hasCustomerSession}
                  defaultValue={defaultShippingAddress?.firstname ?? ""}
                  className={ui.form.input}
                />
              </label>
              <label className="block text-sm">
                <span className={ui.text.label + " mb-1 block"}>Last name *</span>
                <input
                  name="shipping_lastname"
                  type="text"
                  required={!hasCustomerSession}
                  defaultValue={defaultShippingAddress?.lastname ?? ""}
                  className={ui.form.input}
                />
              </label>
              <label className="block text-sm">
                <span className={ui.text.label + " mb-1 block"}>Street line 1 *</span>
                <input
                  name="shipping_street_1"
                  type="text"
                  required={!hasCustomerSession}
                  defaultValue={defaultShippingAddress?.street[0] ?? ""}
                  className={ui.form.input}
                />
              </label>
              <label className="block text-sm">
                <span className={ui.text.label + " mb-1 block"}>Street line 2 (optional)</span>
                <input name="shipping_street_2" type="text" defaultValue={defaultShippingAddress?.street[1] ?? ""} className={ui.form.input} />
              </label>
              <label className="block text-sm">
                <span className={ui.text.label + " mb-1 block"}>City *</span>
                <input
                  name="shipping_city"
                  type="text"
                  required={!hasCustomerSession}
                  defaultValue={defaultShippingAddress?.city ?? ""}
                  className={ui.form.input}
                />
              </label>
              <label className="block text-sm">
                <span className={ui.text.label + " mb-1 block"}>State *</span>
                <select
                  name="shipping_state"
                  required={!hasCustomerSession}
                  defaultValue={defaultShippingAddress?.regionCode ?? defaultShippingAddress?.region ?? ""}
                  className={ui.form.select}
                >
                  <option value="" disabled>Select state</option>
                  {stateOptions.map((state) => (
                    <option key={`${state.code}-${state.name}`} value={state.code}>
                      {state.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className={ui.text.label + " mb-1 block"}>ZIP Code *</span>
                <input
                  name="shipping_postcode"
                  type="text"
                  required={!hasCustomerSession}
                  defaultValue={defaultShippingAddress?.postcode ?? ""}
                  className={ui.form.input}
                />
              </label>
              <label className="block text-sm">
                <span className={ui.text.label + " mb-1 block"}>Country *</span>
                <select name="shipping_country_code" required defaultValue={US_COUNTRY_CODE} className={ui.form.select}>
                  <option value={US_COUNTRY_CODE}>{US_COUNTRY_LABEL}</option>
                </select>
              </label>
              <label className="block text-sm">
                <span className={ui.text.label + " mb-1 block"}>Telephone *</span>
                <input
                  name="shipping_telephone"
                  type="tel"
                  required={!hasCustomerSession}
                  defaultValue={defaultShippingAddress?.telephone ?? ""}
                  className={ui.form.input}
                />
              </label>
              <label className="block text-sm">
                <span className={ui.text.label + " mb-1 block"}>Shipping method *</span>
                <select
                  name="shipping_method"
                  disabled={checkoutUiState.hasMissingShippingMethods}
                  className={ui.form.select}
                  defaultValue={
                    readiness.selectedShippingMethod ??
                    (readiness.availableShippingMethods[0]
                      ? `${readiness.availableShippingMethods[0].carrierCode}:${readiness.availableShippingMethods[0].methodCode}`
                      : "")
                  }
                >
                  {checkoutUiState.hasMissingShippingMethods ? (
                    <option value="">No shipping methods available</option>
                  ) : (
                    readiness.availableShippingMethods.map((method) => (
                      <option key={`${method.carrierCode}:${method.methodCode}`} value={`${method.carrierCode}:${method.methodCode}`}>
                        {method.carrierTitle ?? method.carrierCode} - {method.methodTitle ?? method.methodCode}
                      </option>
                    ))
                  )}
                </select>
              </label>
            </div>
          ) : null}

          <label className="block text-sm">
            <span className={ui.text.label + " mb-1 block"}>Payment method *</span>
            <select name="payment_method" className={ui.form.select} defaultValue={readiness.availablePaymentMethods[0]?.code ?? ""}>
              {readiness.availablePaymentMethods.map((method) => (
                <option key={method.code} value={method.code}>
                  {method.title || method.code}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            disabled={!checkoutUiState.canPlaceOrder}
            className={`${ui.action.buttonPrimary} ${checkoutUiState.canPlaceOrder ? "" : "cursor-not-allowed opacity-60"}`}
          >
            Place order
          </button>
        </form>
      </section>
    </section>
  );
}
