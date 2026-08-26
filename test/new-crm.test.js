const assert = require("node:assert/strict");
const { after, describe, it } = require("node:test");

const router = require("../routes/payment.routes");
const pool = require("../db");

const {
  getDepositStatusFromNormalizedStatus,
  isSameNewCrmPaymentRequest,
  isTerminalNewCrmStatus,
  normalizeNewCrmPaymentRequest,
  normalizePspPaymentStatus,
} = router._test;

after(async () => {
  await pool.end();
});

describe("new CRM payment request validation", () => {
  it("normalizes valid INR request and converts only to paisa", () => {
    const result = normalizeNewCrmPaymentRequest({
      transactionId: " CRM-001 ",
      username: " Pratham S ",
      email: "USER@Example.COM ",
      mobile: "98765-43210",
      amount: 10000.125,
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.request, {
      transactionId: "CRM-001",
      username: "Pratham S",
      email: "user@example.com",
      mobile: "9876543210",
      amount: 10000.125,
    });
    assert.equal(result.amountPaisa, 1000013);
  });

  it("rejects missing or malformed fields before PSP work", () => {
    const result = normalizeNewCrmPaymentRequest({
      transactionId: "",
      username: "",
      email: "bad-email",
      mobile: "123",
      amount: 0,
    });

    assert.equal(result.errors.length, 5);
    assert.equal(result.amountPaisa, 0);
  });

  it("rejects client supplied callback or return URLs", () => {
    const result = normalizeNewCrmPaymentRequest({
      transactionId: "CRM-001",
      username: "Test User",
      email: "test@example.com",
      mobile: "9876543210",
      amount: 10000,
      callbackUrl: "https://example.com/callback",
    });

    assert.deepEqual(result.errors, [
      "callback and return URLs are not accepted in payment requests",
    ]);
  });
});

describe("new CRM idempotency comparison", () => {
  it("matches only the exact original request and amount", () => {
    const request = {
      transactionId: "CRM-001",
      username: "Pratham S",
      email: "user@example.com",
      mobile: "9876543210",
      amount: 10000,
    };
    const row = {
      external_request: request,
      amount_paisa: 1000000,
    };

    assert.equal(isSameNewCrmPaymentRequest(row, request, 1000000), true);
    assert.equal(
      isSameNewCrmPaymentRequest(row, { ...request, amount: 10001 }, 1000100),
      false
    );
    assert.equal(
      isSameNewCrmPaymentRequest(row, { ...request, email: "other@example.com" }, 1000000),
      false
    );
  });
});

describe("new CRM PSP status normalization", () => {
  it("maps PSP success to completed", () => {
    assert.equal(
      normalizePspPaymentStatus({ Result: { StatusCode: 1, IsSuccess: true, Utr: "123" } }),
      "completed"
    );
    assert.equal(getDepositStatusFromNormalizedStatus("completed"), "COMPLETED");
    assert.equal(isTerminalNewCrmStatus("completed"), true);
  });

  it("supports failed, cancelled, expired, and pending statuses", () => {
    assert.equal(normalizePspPaymentStatus({ Result: { message: "payment expired" } }), "expired");
    assert.equal(normalizePspPaymentStatus({ Result: { message: "cancelled by user" } }), "cancelled");
    assert.equal(normalizePspPaymentStatus({ Result: { IsSuccess: false } }), "failed");
    assert.equal(normalizePspPaymentStatus({ Result: { message: "processing" } }), "pending");
    assert.equal(isTerminalNewCrmStatus("pending"), false);
  });
});
