import { createHash } from "node:crypto";

/**
 * MOCK ONLY (throw this file away) — a faithful port of the server-side validator
 * (`the server-side request validator` on our side), so the error messages and the
 * `error.fields` keys you code against locally are the ones the real API sends.
 *
 * Every field error is collected into ONE 400 `validation_error`; `message` is
 * `"Request validation failed: " + <every field message joined with "; ">`.
 */

const PROPERTY_TYPES = new Set(["apartment", "house"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const MAX_EXTERNAL_REFERENCE_LENGTH = 128;
export const MAX_WEBHOOK_URL_LENGTH = 1024;

/** Unit separator: the field delimiter the server hashes with. */
const SEP = "\u001f";

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

function numberIn(raw, field, min, max, errors) {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw).trim());
  if (Number.isNaN(value)) {
    errors[field] = `${field} must be a number`;
    return null;
  }
  if (value < min || value > max) {
    errors[field] = `${field} must be between ${min} and ${max}`;
    return null;
  }
  return value;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Port of `the webhook URL validator`: http(s) only, https required in the live environment,
 * a host must be present, no embedded credentials, and loopback / link-local / private /
 * multicast literals are rejected.
 *
 * NOTE for local development: this is exactly why the sample does NOT send a per-request
 * `webhookUrl` pointing at your laptop — `http://localhost:4000/...` is rejected here and by
 * the real API. Local deliveries use the ACCOUNT webhook URL instead (`MOCK_WEBHOOK_URL`),
 * which mirrors the URL the ResidenceVertical team configures on your partner account.
 */
export function validateWebhookUrl(rawUrl, liveEnvironment) {
  if (!rawUrl || !rawUrl.trim()) return { error: "webhookUrl must not be blank" };
  const value = rawUrl.trim();
  if (value.length > MAX_WEBHOOK_URL_LENGTH) {
    return { error: `webhookUrl must be at most ${MAX_WEBHOOK_URL_LENGTH} characters` };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: "webhookUrl is not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "webhookUrl must use http or https" };
  }
  if (liveEnvironment && url.protocol !== "https:") {
    return { error: "webhookUrl must use https in the live environment" };
  }
  if (!url.hostname) return { error: "webhookUrl must include a host" };
  if (url.username || url.password) return { error: "webhookUrl must not embed credentials" };
  if (isForbiddenHost(url.hostname)) {
    return {
      error: "webhookUrl must point at a public host "
        + "(loopback, link-local and private addresses are rejected)",
    };
  }
  return { url: value };
}

/** `localhost`, and literal loopback / private / link-local / CGNAT / any-local IPs. */
export function isForbiddenHost(host) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost") || value === "0.0.0.0") return true;
  if (value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80")) return true;
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map(Number);
  return a === 127 || a === 10 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

/** @returns {{ok: true, input: object} | {ok: false, message: string, fields: object}} */
export function validateCreateReportBody(rawBody, { liveEnvironment = false } = {}) {
  const body = rawBody && typeof rawBody === "object" ? rawBody : {};
  const errors = {};

  const address = body.address && typeof body.address === "object" ? body.address : {};
  if (Object.keys(address).length === 0) errors["address"] = "address is required";
  const street = required(address, "street", "address.street", 255, errors);
  const streetNumber = required(address, "streetNumber", "address.streetNumber", 32, errors);
  const city = required(address, "city", "address.city", 128, errors);
  const county = optional(address, "county", "address.county", 128, errors);
  const postalCode = optional(address, "postalCode", "address.postalCode", 32, errors);

  let lat = null;
  let lng = null;
  if (body.coordinates && typeof body.coordinates === "object") {
    lat = numberIn(body.coordinates.lat, "coordinates.lat", -90, 90, errors);
    lng = numberIn(body.coordinates.lng, "coordinates.lng", -180, 180, errors);
    if ((lat === null) !== (lng === null) && !errors["coordinates.lat"] && !errors["coordinates.lng"]) {
      errors["coordinates"] = "coordinates must include both lat and lng";
    }
  } else if (body.coordinates !== null && body.coordinates !== undefined) {
    errors["coordinates"] = "coordinates must be an object {lat, lng}";
  }
  if (lat === null || lng === null) {
    lat = null;
    lng = null;
  }

  const propertyType = text(body.propertyType).toLowerCase();
  if (!propertyType) {
    errors["propertyType"] = "propertyType is required (apartment | house)";
  } else if (!PROPERTY_TYPES.has(propertyType)) {
    errors["propertyType"] = "propertyType must be one of: apartment, house";
  }

  const residentialComplex = optional(body, "residentialComplex", "residentialComplex", 255, errors);
  const adUrl = optional(body, "adUrl", "adUrl", 1024, errors);
  if (adUrl && !isHttpUrl(adUrl)) errors["adUrl"] = "adUrl must be an http(s) URL";

  const customer = body.customer && typeof body.customer === "object" ? body.customer : {};
  const customerEmail = optional(customer, "email", "customer.email", 255, errors);
  if (customerEmail && !EMAIL.test(customerEmail)) {
    errors["customer.email"] = "customer.email must be a valid email address";
  }
  const customerName = optional(customer, "name", "customer.name", 255, errors);
  const externalReference = optional(body, "externalReference", "externalReference", MAX_EXTERNAL_REFERENCE_LENGTH, errors);

  let webhookUrl = optional(body, "webhookUrl", "webhookUrl", MAX_WEBHOOK_URL_LENGTH, errors);
  if (webhookUrl) {
    const result = validateWebhookUrl(webhookUrl, liveEnvironment);
    if (result.error) errors["webhookUrl"] = result.error;
    else webhookUrl = result.url;
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
      lat,
      lng,
      propertyType,
      residentialComplex,
      adUrl,
      customerEmail: customerEmail ? customerEmail.toLowerCase() : null,
      customerName,
      externalReference,
      webhookUrl,
    },
  };
}

export const CHECKOUT_LINK_DEFAULT_HOURS = 48;
export const CHECKOUT_LINK_MIN_HOURS = 1;
export const CHECKOUT_LINK_MAX_HOURS = 720;

/**
 * `POST /checkout-links` (guide §2.1) — deliberately REUSES the create-report rules for the
 * address / propertyType / customer.email fields (the real validator does the same), minus the
 * fields a checkout link does not take: no coordinates (the buy flow geocodes as usual), no
 * adUrl, no webhookUrl, no customer.name. Plus `expiresInHours`: an integer, 1..720, default 48.
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

/** `Idempotency-Key` header: ≤128 chars, trimmed; blank → null. */
export function validateIdempotencyKey(header) {
  if (!header || !header.trim()) return { key: null };
  const key = header.trim();
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return {
      error: {
        message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
        fields: { "Idempotency-Key": `must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters` },
      },
    };
  }
  return { key };
}

/**
 * The canonical request hash used for `Idempotency-Key` conflict detection. Same idea as the
 * server: SHA-256 over the NORMALIZED input joined with the unit separator (adjacent fields can
 * never collide), which is why key order / whitespace never cause a false 409.
 */
export function requestHash(input) {
  const canonical = [
    input.street, input.streetNumber, input.city, input.county, input.postalCode,
    input.lat === null ? "" : String(input.lat), input.lng === null ? "" : String(input.lng),
    input.propertyType, input.residentialComplex, input.adUrl, input.customerEmail,
    input.customerName, input.externalReference, input.webhookUrl,
  ].map((value) => (value === null || value === undefined ? "" : String(value))).join(SEP);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
