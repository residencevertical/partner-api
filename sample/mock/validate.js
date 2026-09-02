/**
 * MOCK ONLY (throw this file away) — a faithful port of the server-side validator for
 * `POST /checkout-links` (guide §8.1), so the error messages and the `error.fields` keys you
 * code against locally are the ones the real API sends.
 *
 * Every field error is collected into ONE 400 `validation_error`; `message` is
 * `"Request validation failed: " + <every field message joined with "; ">`.
 */

const PROPERTY_TYPES = new Set(["apartment", "house"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EXTERNAL_REFERENCE_LENGTH = 128;

export const CHECKOUT_LINK_DEFAULT_HOURS = 48;
export const CHECKOUT_LINK_MIN_HOURS = 1;
export const CHECKOUT_LINK_MAX_HOURS = 720;

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

function required(source, key, field, maxLength, errors) {
  const value = text(source?.[key]);
  if (!value) {
    errors[field] = `${field} is required`;
    return null;
  }
  if (value.length > maxLength) {
    errors[field] = `${field} must be at most ${maxLength} characters`;
    return null;
  }
  return value;
}

function optional(source, key, field, maxLength, errors) {
  const value = text(source?.[key]);
  if (!value) return null;
  if (value.length > maxLength) {
    errors[field] = `${field} must be at most ${maxLength} characters`;
    return null;
  }
  return value;
}

/**
 * `POST /checkout-links`: address / propertyType / customer.email / externalReference, plus
 * `expiresInHours` — an integer, 1..720, default 48. No coordinates (the buy flow geocodes the
 * address for the buyer exactly as it does for a direct customer).
 *
 * @returns {{ok: true, input: object} | {ok: false, message: string, fields: object}}
 */
export function validateCreateCheckoutLinkBody(rawBody) {
  const body = rawBody && typeof rawBody === "object" ? rawBody : {};
  const errors = {};

  const address = body.address && typeof body.address === "object" ? body.address : {};
  if (Object.keys(address).length === 0) errors["address"] = "address is required";
  const street = required(address, "street", "address.street", 255, errors);
  const streetNumber = required(address, "streetNumber", "address.streetNumber", 32, errors);
  const city = required(address, "city", "address.city", 128, errors);
  const county = optional(address, "county", "address.county", 128, errors);
  const postalCode = optional(address, "postalCode", "address.postalCode", 32, errors);

  const propertyType = text(body.propertyType).toLowerCase();
  if (!propertyType) {
    errors["propertyType"] = "propertyType is required (apartment | house)";
  } else if (!PROPERTY_TYPES.has(propertyType)) {
    errors["propertyType"] = "propertyType must be one of: apartment, house";
  }

  const customer = body.customer && typeof body.customer === "object" ? body.customer : {};
  const customerEmail = optional(customer, "email", "customer.email", 255, errors);
  if (customerEmail && !EMAIL.test(customerEmail)) {
    errors["customer.email"] = "customer.email must be a valid email address";
  }
  const externalReference = optional(body, "externalReference", "externalReference", MAX_EXTERNAL_REFERENCE_LENGTH, errors);

  let expiresInHours = CHECKOUT_LINK_DEFAULT_HOURS;
  if (body.expiresInHours !== null && body.expiresInHours !== undefined) {
    const raw = typeof body.expiresInHours === "number"
      ? body.expiresInHours : Number.parseFloat(String(body.expiresInHours).trim());
    if (!Number.isInteger(raw) || raw < CHECKOUT_LINK_MIN_HOURS || raw > CHECKOUT_LINK_MAX_HOURS) {
      errors["expiresInHours"] = `expiresInHours must be an integer between ${CHECKOUT_LINK_MIN_HOURS} and ${CHECKOUT_LINK_MAX_HOURS}`;
    } else {
      expiresInHours = raw;
    }
  }

  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      message: `Request validation failed: ${Object.values(errors).join("; ")}`,
      fields: errors,
    };
  }
  return {
    ok: true,
    input: {
      street,
      streetNumber,
      city,
      county,
      postalCode,
      propertyType,
      customerEmail: customerEmail ? customerEmail.toLowerCase() : null,
      externalReference,
      expiresInHours,
    },
  };
}
