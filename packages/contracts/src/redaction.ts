/**
 * Redaction for trace payloads.
 *
 * Every step input, output and error passes through `redactJson` /
 * `redactText` before it is stored, so a trace never holds raw secrets or
 * personal data. Values are replaced with a `[REDACTED:<reason>]` marker and
 * the path of each replacement is recorded, so a reviewer can see *that* a
 * field was removed without seeing its value.
 *
 * The rules are plain functions with no clock or randomness: the same payload
 * always redacts to the same result, and redacting twice changes nothing.
 */

export const REDACTION_REASONS = [
  "secret",
  "email",
  "card_number",
  "phone",
  "personal_id",
] as const;
export type RedactionReason = (typeof REDACTION_REASONS)[number];

export interface Redaction {
  /** Where the value was, e.g. `input.customer.email` or `input.items[0]`. */
  path: string;
  reason: RedactionReason;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const redactionMarker = (reason: RedactionReason) => `[REDACTED:${reason}]`;

/**
 * Field names whose value is always removed, whatever it looks like. Names are
 * compared after lower-casing and dropping everything but letters and digits,
 * so `api_key`, `apiKey` and `API-KEY` all match `apikey`.
 */
const FIELD_RULES: ReadonlyArray<{ reason: RedactionReason; exact: readonly string[]; suffixes: readonly string[] }> = [
  {
    reason: "secret",
    exact: ["authorization", "cookie", "setcookie", "sessionid", "privatekey", "passphrase", "otp", "pin"],
    suffixes: ["password", "passwd", "secret", "token", "apikey", "credential", "credentials"],
  },
  { reason: "email", exact: ["email", "emailaddress", "mail"], suffixes: ["email"] },
  {
    reason: "card_number",
    exact: ["cardnumber", "creditcard", "creditcardnumber", "pan", "cvv", "cvc", "cardcvc", "cardcvv"],
    suffixes: [],
  },
  { reason: "phone", exact: ["phone", "phonenumber", "mobile", "mobilenumber", "telephone"], suffixes: ["phone"] },
  {
    reason: "personal_id",
    exact: [
      "ssn",
      "socialsecuritynumber",
      "taxid",
      "nationalid",
      "passport",
      "passportnumber",
      "iban",
      "accountnumber",
      "routingnumber",
      "dateofbirth",
      "dob",
      "birthdate",
    ],
    suffixes: [],
  },
];

const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The reason a field with this name is always redacted, or null. */
export function sensitiveFieldReason(key: string): RedactionReason | null {
  const name = normalizeKey(key);
  if (name.length === 0) return null;
  for (const rule of FIELD_RULES) {
    if (rule.exact.includes(name) || rule.suffixes.some((suffix) => name.endsWith(suffix))) {
      return rule.reason;
    }
  }
  return null;
}

/** Luhn checksum, so order numbers and timestamps are not mistaken for cards. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

interface TextRule {
  reason: RedactionReason;
  pattern: RegExp;
  /** Extra check on a match; the match is kept as-is when this returns false. */
  accept?: (match: string) => boolean;
}

/** Applied in order; secrets first so a token containing an `@` stays one secret. */
const TEXT_RULES: readonly TextRule[] = [
  { reason: "secret", pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/g },
  { reason: "secret", pattern: /\b(?:sk|pk|rk)[-_](?:live[-_]|test[-_]|ant[-_])?[A-Za-z0-9\-_]{16,}/g },
  { reason: "secret", pattern: /\balk_[A-Za-z0-9]{16,}/g },
  { reason: "secret", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { reason: "secret", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { reason: "secret", pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { reason: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  {
    reason: "card_number",
    pattern: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    accept: (match) => passesLuhn(match.replace(/[ -]/g, "")),
  },
  {
    reason: "phone",
    pattern: /\+\d[\d\s().-]{6,18}\d/g,
    accept: (match) => {
      const digits = match.replace(/\D/g, "").length;
      return digits >= 8 && digits <= 15;
    },
  },
];

export interface RedactedText {
  text: string;
  /** Each reason at most once, in rule order. */
  reasons: RedactionReason[];
}

/** Replaces secrets and personal data found inside free text. */
export function redactText(text: string): RedactedText {
  const reasons: RedactionReason[] = [];
  let result = text;
  for (const rule of TEXT_RULES) {
    result = result.replace(rule.pattern, (match) => {
      if (rule.accept !== undefined && !rule.accept(match)) return match;
      if (!reasons.includes(rule.reason)) reasons.push(rule.reason);
      return redactionMarker(rule.reason);
    });
  }
  return { text: result, reasons };
}

export interface RedactedJson<T extends JsonValue = JsonValue> {
  value: T;
  redactions: Redaction[];
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function childPath(parent: string, key: string): string {
  if (IDENTIFIER.test(key)) return parent === "" ? key : `${parent}.${key}`;
  return `${parent}[${JSON.stringify(key)}]`;
}

/**
 * Returns a redacted copy of a JSON value (the input is not changed):
 * values under sensitive field names are replaced whole, strings are scanned
 * with the text rules, and object keys that themselves contain personal data
 * (say, a map keyed by email address) are replaced too.
 */
export function redactJson<T extends JsonValue>(value: T, path = ""): RedactedJson<T> {
  const redactions: Redaction[] = [];

  const visit = (current: JsonValue, at: string): JsonValue => {
    if (typeof current === "string") {
      const { text, reasons } = redactText(current);
      for (const reason of reasons) redactions.push({ path: at, reason });
      return text;
    }
    if (Array.isArray(current)) {
      return current.map((item, index) => visit(item, `${at}[${index}]`));
    }
    if (current !== null && typeof current === "object") {
      const out: JsonObject = {};
      for (const [rawKey, child] of Object.entries(current)) {
        const redactedKey = redactText(rawKey);
        let key = redactedKey.text;
        if (redactedKey.reasons.length > 0) {
          // Keep keys unique when several of them are redacted.
          let n = 1;
          while (Object.hasOwn(out, `${redactedKey.text}#${n}`)) n += 1;
          key = `${redactedKey.text}#${n}`;
          for (const reason of redactedKey.reasons) redactions.push({ path: childPath(at, key), reason });
        }
        const fieldReason = sensitiveFieldReason(rawKey);
        if (fieldReason !== null && !isMarker(child, fieldReason)) {
          out[key] = redactionMarker(fieldReason);
          redactions.push({ path: childPath(at, key), reason: fieldReason });
        } else {
          out[key] = visit(child, childPath(at, key));
        }
      }
      return out;
    }
    return current;
  };

  return { value: visit(value, path) as T, redactions };
}

/** Already redacted with this reason: redacting again must not add a record. */
function isMarker(value: JsonValue, reason: RedactionReason): boolean {
  return value === redactionMarker(reason) || value === null;
}
