import { describe, expect, it } from "vitest";
import { redactJson, redactText, sensitiveFieldReason, type JsonObject } from "../src/index.js";

describe("sensitiveFieldReason", () => {
  it.each([
    ["password", "secret"],
    ["db_password", "secret"],
    ["apiKey", "secret"],
    ["API-KEY", "secret"],
    ["accessToken", "secret"],
    ["Authorization", "secret"],
    ["customerEmail", "email"],
    ["card_number", "card_number"],
    ["cvv", "card_number"],
    ["phoneNumber", "phone"],
    ["homePhone", "phone"],
    ["ssn", "personal_id"],
    ["dateOfBirth", "personal_id"],
    ["iban", "personal_id"],
  ])("redacts %s as %s", (key, reason) => {
    expect(sensitiveFieldReason(key)).toBe(reason);
  });

  it.each(["orderNumber", "maxOutputTokens", "inputTokens", "tokenCount", "status", "", "_"])(
    "keeps %s",
    (key) => {
      expect(sensitiveFieldReason(key)).toBeNull();
    },
  );
});

describe("redactText", () => {
  it("replaces emails, secrets, card numbers and phone numbers", () => {
    const { text, reasons } = redactText(
      "Mail ana.ruiz@example.test, key sk-test-AbCdEfGhIjKlMnOpQrSt, card 4111 1111 1111 1111, call +44 20 7946 0958.",
    );
    expect(text).toBe(
      "Mail [REDACTED:email], key [REDACTED:secret], card [REDACTED:card_number], call [REDACTED:phone].",
    );
    expect(reasons).toEqual(["secret", "email", "card_number", "phone"]);
  });

  it("catches bearer headers, AgentLedger tokens and JWTs", () => {
    const { text } = redactText(
      "Authorization: Bearer abc.def-123456 then alk_0123456789abcdef01 and eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl",
    );
    expect(text).toBe("Authorization: [REDACTED:secret] then [REDACTED:secret] and [REDACTED:secret]");
  });

  it("leaves numbers that are not card numbers alone", () => {
    // 16 digits failing the Luhn check, an order number and a date.
    const input = "Order 1234567812345678, ref A-1001, placed 2026-11-25, total 1499 cents.";
    expect(redactText(input)).toEqual({ text: input, reasons: [] });
  });

  it("is idempotent", () => {
    const once = redactText("Reach me at lee@example.test or +1 (555) 010-9999.").text;
    expect(redactText(once)).toEqual({ text: once, reasons: [] });
  });
});

describe("redactJson", () => {
  const payload: JsonObject = {
    orderNumber: "A-1001",
    customer: {
      name: "Lee Park",
      email: "lee.park@example.test",
      phone: { country: "+1", number: "555 0100" },
      note: "Prefers mail to lee.park@example.test",
    },
    payment: { cardNumber: "4242424242424242", last4: "4242" },
    attempts: [{ token: "abc" }, "card 5555 5555 5555 4444 declined"],
    contacts: { "ops@example.test": "primary", "billing@example.test": "backup" },
    password: null,
    maxOutputTokens: 512,
  };

  it("replaces sensitive fields and text and lists every path", () => {
    const { value, redactions } = redactJson(payload, "input");
    expect(value).toEqual({
      orderNumber: "A-1001",
      customer: {
        name: "Lee Park",
        email: "[REDACTED:email]",
        phone: "[REDACTED:phone]",
        note: "Prefers mail to [REDACTED:email]",
      },
      payment: { cardNumber: "[REDACTED:card_number]", last4: "4242" },
      attempts: [{ token: "[REDACTED:secret]" }, "card [REDACTED:card_number] declined"],
      contacts: { "[REDACTED:email]#1": "primary", "[REDACTED:email]#2": "backup" },
      password: null,
      maxOutputTokens: 512,
    });
    expect(redactions).toEqual([
      { path: "input.customer.email", reason: "email" },
      { path: "input.customer.phone", reason: "phone" },
      { path: "input.customer.note", reason: "email" },
      { path: "input.payment.cardNumber", reason: "card_number" },
      { path: "input.attempts[0].token", reason: "secret" },
      { path: "input.attempts[1]", reason: "card_number" },
      { path: 'input.contacts["[REDACTED:email]#1"]', reason: "email" },
      { path: 'input.contacts["[REDACTED:email]#2"]', reason: "email" },
    ]);
  });

  it("does not change its input and is idempotent", () => {
    const before = structuredClone(payload);
    const once = redactJson(payload);
    expect(payload).toEqual(before);
    expect(redactJson(once.value)).toEqual({ value: once.value, redactions: [] });
  });

  it("leaves no raw sensitive value anywhere in the output", () => {
    const text = JSON.stringify(redactJson(payload).value);
    for (const raw of ["lee.park@example.test", "4242424242424242", "5555 5555 5555 4444", "555 0100", "ops@example.test"]) {
      expect(text).not.toContain(raw);
    }
  });
});
