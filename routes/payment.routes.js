const express = require("express");
const { randomUUID } = require("crypto");
const pool = require("../db");
const {
  createPayin,
  checkStatus,
  extractHostedToken,
  fetchHostedPaymentDetails,
  submitManualDeposit,
  validateCrmEmail,
  createPayout,
  checkPayoutStatus,
  checkMultiplePayoutStatuses,
  checkPayoutBalance,
} = require("../services/psp.service");
const axios = require("axios");
const router = express.Router();
let payoutsTableReadyPromise = null;
let depositsTableReadyPromise = null;

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_PANEL_KEY) {
    return res.status(503).json({ error: "Admin panel key is not configured" });
  }

  const adminKey = req.headers["x-admin-key"];

  if (adminKey !== process.env.ADMIN_PANEL_KEY) {
    return res.status(401).json({ error: "Invalid admin key" });
  }

  next();
}

function requirePayoutApiKey(req, res, next) {
  if (!process.env.PAYOUT_API_KEY) {
    return res.status(503).json({ error: "Payout API key is not configured" });
  }

  const authHeader = String(req.headers.authorization || "");
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7)
    : null;
  const apiKey = req.headers["x-api-key"] || bearerToken;

  if (apiKey !== process.env.PAYOUT_API_KEY) {
    return res.status(401).json({ error: "Invalid payout API key" });
  }

  next();
}

async function ensurePayoutsTable() {
  if (payoutsTableReadyPromise) {
    return payoutsTableReadyPromise;
  }

  payoutsTableReadyPromise = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payouts (
      id UUID PRIMARY KEY,
      account_number TEXT NOT NULL,
      ifsc TEXT NOT NULL,
      bank_name TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      amount_usd NUMERIC(12,2),
      usd_to_inr_rate NUMERIC(12,4),
      amount_paisa INTEGER,
      beneficiary_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'CREATED',
      psp_status TEXT,
      message TEXT,
      code TEXT,
      utr TEXT,
      order_id TEXT,
      psp_response JSONB,
      status_response JSONB,
      webhook_response JSONB,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE payouts
    ADD COLUMN IF NOT EXISTS amount_usd NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS usd_to_inr_rate NUMERIC(12,4),
    ADD COLUMN IF NOT EXISTS amount_paisa INTEGER,
    ADD COLUMN IF NOT EXISTS email TEXT,
    ADD COLUMN IF NOT EXISTS phone TEXT,
    ADD COLUMN IF NOT EXISTS message TEXT,
    ADD COLUMN IF NOT EXISTS code TEXT,
    ADD COLUMN IF NOT EXISTS utr TEXT,
    ADD COLUMN IF NOT EXISTS order_id TEXT,
    ADD COLUMN IF NOT EXISTS webhook_response JSONB
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payouts_updated_at ON payouts (updated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payouts_status_updated_at ON payouts (UPPER(status), updated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payouts_email_lower ON payouts (LOWER(email))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payouts_order_id ON payouts (order_id)`);
  })().catch((err) => {
    payoutsTableReadyPromise = null;
    throw err;
  });

  return payoutsTableReadyPromise;
}

function normalizePayoutStatus(payload, fallback) {
  if (!payload) {
    return fallback;
  }

  const data = payload.Result || payload.result || payload;

  if (typeof data.transactionStatus === "string") {
    return data.transactionStatus;
  }

  if (typeof data.Status === "string") {
    return data.Status;
  }

  if (typeof data.status === "string") {
    return data.status;
  }

  if (typeof data.StatusCode !== "undefined") {
    if (data.IsSuccess === true || data.StatusCode === 1) {
      return "SUCCESS";
    }

    if (data.IsSuccess === false) {
      return "FAILED";
    }

    return String(data.StatusCode);
  }

  if (typeof payload.message === "string") {
    return payload.message;
  }

  return fallback;
}

function serializePayout(row) {
  return {
    id: row.id,
    accountNumber: row.account_number,
    ifsc: row.ifsc,
    bankName: row.bank_name,
    amount: Number(row.amount),
    amountUsd: row.amount_usd === null || typeof row.amount_usd === "undefined" ? null : Number(row.amount_usd),
    usdToInrRate: row.usd_to_inr_rate === null || typeof row.usd_to_inr_rate === "undefined" ? null : Number(row.usd_to_inr_rate),
    amountPaisa: row.amount_paisa,
    name: row.beneficiary_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    statusCategory: getPayoutStatusCategory(row.status),
    pspStatus: row.psp_status,
    message: row.message,
    code: row.code,
    utr: row.utr,
    orderId: row.order_id,
    pspResponse: row.psp_response,
    statusResponse: row.status_response,
    webhookResponse: row.webhook_response,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getPayoutStatusCategory(status) {
  const normalized = String(status || "").toUpperCase();

  if (["SUCCESS", "COMPLETED", "DONE"].includes(normalized)) {
    return "success";
  }

  if (["FAIL", "FAILED", "REQUEST_FAILED"].includes(normalized)) {
    return "failed";
  }

  if (["CREATED", "INITIATED", "PENDING"].includes(normalized)) {
    return "pending";
  }

  return "incomplete";
}

function getPayoutStatusFilter(status) {
  const normalized = String(status || "").trim().toUpperCase();

  if (!normalized) {
    return null;
  }

  if (normalized === "SUCCESS") {
    return { include: ["SUCCESS", "COMPLETED", "DONE"] };
  }

  if (normalized === "FAILED") {
    return { include: ["FAIL", "FAILED", "REQUEST_FAILED"] };
  }

  if (normalized === "PENDING") {
    return { include: ["CREATED", "INITIATED", "PENDING"] };
  }

  if (normalized === "INCOMPLETE") {
    return { exclude: ["SUCCESS", "COMPLETED", "DONE", "FAIL", "FAILED", "REQUEST_FAILED", "CREATED", "INITIATED", "PENDING"] };
  }

  return { include: [normalized] };
}

function getPayoutWebhookKey() {
  return process.env.PSP_PAYOUT_PRIVATE_KEY || process.env.PAYOUT_PRIVATE_KEY;
}

function getPayoutMeta(payload) {
  const data = payload && (payload.Result || payload.result || payload);

  return {
    message: data && typeof data.message === "string" ? data.message : null,
    code: data && typeof data.code === "string" ? data.code : null,
    utr: data && typeof data.utr === "string" ? data.utr : null,
    orderId: data && typeof data.orderId === "string" ? data.orderId : null,
    amountPaisa: data && Number.isFinite(Number(data.amount)) ? Number(data.amount) : null,
  };
}

async function ensureDepositsTable() {
  if (depositsTableReadyPromise) {
    return depositsTableReadyPromise;
  }

  depositsTableReadyPromise = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id UUID PRIMARY KEY,
      username TEXT,
      client_code TEXT,
      email TEXT,
      mobile TEXT,
      amount_inr NUMERIC(12,2),
      amount_paisa INTEGER,
      status TEXT NOT NULL DEFAULT 'CREATED',
      utr TEXT,
      hosted_url TEXT,
      hosted_token TEXT,
      psp_deposit_id TEXT,
      payment_details JSONB,
      psp_response JSONB,
      manual_deposit_response JSONB,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE deposits
    ADD COLUMN IF NOT EXISTS utr TEXT,
    ADD COLUMN IF NOT EXISTS hosted_url TEXT,
    ADD COLUMN IF NOT EXISTS hosted_token TEXT,
    ADD COLUMN IF NOT EXISTS psp_deposit_id TEXT,
    ADD COLUMN IF NOT EXISTS payment_details JSONB,
    ADD COLUMN IF NOT EXISTS psp_response JSONB,
    ADD COLUMN IF NOT EXISTS manual_deposit_response JSONB,
    ADD COLUMN IF NOT EXISTS error_message TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deposits_updated_at ON deposits (updated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deposits_status_updated_at ON deposits (UPPER(status), updated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deposits_email_lower ON deposits (LOWER(email))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deposits_mobile ON deposits (mobile)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deposits_utr ON deposits (utr)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deposits_hosted_token ON deposits (hosted_token)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deposits_psp_deposit_id ON deposits (psp_deposit_id)`);
  })().catch((err) => {
    depositsTableReadyPromise = null;
    throw err;
  });

  return depositsTableReadyPromise;
}

function getPayinRedirectUrl(pspResponse) {
  return (
    pspResponse &&
    (pspResponse.Url ||
      pspResponse.url ||
      pspResponse.RedirectUrl ||
      pspResponse.redirectUrl ||
      pspResponse.PaymentUrl ||
      pspResponse.paymentUrl)
  );
}

function getPspDepositId(pspResponse) {
  return (
    pspResponse &&
    (pspResponse.DepositId ||
      pspResponse.depositId ||
      pspResponse.TransactionNo ||
      pspResponse.transactionNo ||
      pspResponse.OrderId ||
      pspResponse.orderId)
  );
}

function serializeDeposit(row) {
  return {
    id: row.id,
    amount: Number(row.amount_inr),
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializePayin(row) {
  const details = row.payment_details || {};
  const manualResponse = row.manual_deposit_response || {};

  return {
    id: row.id,
    pspDepositId: row.psp_deposit_id,
    hostedToken: row.hosted_token,
    username: row.username,
    clientCode: row.client_code,
    email: row.email,
    mobile: row.mobile,
    amount: Number(row.amount_inr),
    amountPaisa: row.amount_paisa,
    status: row.status,
    statusCategory: getPayinStatusCategory(row.status),
    utr: row.utr,
    orderId: details.orderId || details.rechargeReqId || row.psp_deposit_id || null,
    paymentMethod: details.paymentMethod || null,
    bankName: details.bankName || null,
    accountHolder: details.accountHolder || null,
    accountNumber: details.accountNumber || null,
    ifsc: details.ifsc || null,
    manualMessage: getManualDepositMessage(manualResponse),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paymentDetails: details,
    manualDepositResponse: manualResponse,
  };
}

function getPayinStatusCategory(status) {
  const normalized = String(status || "").toUpperCase();

  if (["COMPLETED", "UTR_SUBMITTED", "SUCCESS", "DONE"].includes(normalized)) {
    return "success";
  }

  if (["FAILED", "FAIL", "REQUEST_FAILED", "DETAILS_FETCH_FAILED", "UTR_REJECTED", "UTR_SUBMIT_FAILED", "AMOUNT_MISMATCH"].includes(normalized)) {
    return "failed";
  }

  if (["CREATED", "INITIATED", "PENDING"].includes(normalized)) {
    return "pending";
  }

  return "incomplete";
}

function getPayinStatusesForFilter(status) {
  const normalized = String(status || "").trim().toUpperCase();

  if (!normalized) {
    return null;
  }

  if (normalized === "SUCCESS") {
    return ["COMPLETED", "UTR_SUBMITTED", "SUCCESS", "DONE"];
  }

  if (normalized === "FAILED") {
    return ["FAILED", "FAIL", "REQUEST_FAILED", "DETAILS_FETCH_FAILED", "UTR_REJECTED", "UTR_SUBMIT_FAILED", "AMOUNT_MISMATCH"];
  }

  if (normalized === "PENDING") {
    return ["CREATED", "INITIATED", "PENDING"];
  }

  if (normalized === "INCOMPLETE") {
    return ["UTR_ALREADY_INITIATED"];
  }

  return [normalized];
}

function getPublicPaymentDetails(paymentDetails) {
  if (!paymentDetails) {
    return null;
  }

  return {
    orderId: paymentDetails.orderId || null,
    amount: paymentDetails.amount || null,
    upiId: paymentDetails.upiId || null,
    qrCode: paymentDetails.qrCode || null,
    bankName: paymentDetails.bankName || null,
    accountHolder: paymentDetails.accountHolder || null,
    accountNumber: paymentDetails.accountNumber || null,
    ifsc: paymentDetails.ifsc || null,
  };
}

function getManualDepositStatusPayload(payload) {
  return payload && (payload.Status || payload.status || payload.Result || payload.result || payload);
}

function getManualDepositMessage(payload) {
  const data = getManualDepositStatusPayload(payload);
  return data && (data.returnMessage || data.ReturnMessage || data.message || data.Message);
}

const IST_OFFSET_MINUTES = 330;

function getIstParts(date) {
  const istDate = new Date(date.getTime() + IST_OFFSET_MINUTES * 60 * 1000);

  return {
    year: istDate.getUTCFullYear(),
    month: istDate.getUTCMonth(),
    date: istDate.getUTCDate(),
    hours: istDate.getUTCHours(),
    minutes: istDate.getUTCMinutes(),
  };
}

function istDateToUtcDate(year, month, date, hours, minutes, seconds, milliseconds) {
  return new Date(Date.UTC(year, month, date, hours, minutes, seconds, milliseconds) - IST_OFFSET_MINUTES * 60 * 1000);
}

function parseIstDateTime(value, fallback, isEndDate = false) {
  if (!value) {
    return fallback;
  }

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);

  if (!match) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }

  const date = istDateToUtcDate(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    match[6] ? Number(match[6]) : (isEndDate ? 59 : 0),
    isEndDate ? 999 : 0
  );

  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return date;
}

function getCommissionRate(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function getDateRange(req) {
  const nowIst = getIstParts(new Date());
  const startFallback = istDateToUtcDate(nowIst.year, nowIst.month, nowIst.date, 0, 0, 0, 0);
  const endFallback = istDateToUtcDate(nowIst.year, nowIst.month, nowIst.date, 23, 59, 59, 999);

  return {
    startDate: parseIstDateTime(req.query.startDate, startFallback, false),
    endDate: parseIstDateTime(req.query.endDate, endFallback, true),
  };
}

function normalizeManualDepositStatus(payload) {
  const data = getManualDepositStatusPayload(payload);

  if (!data) {
    return "UTR_SUBMITTED";
  }

  if (data.IsSuccess === false || data.isSuccess === false) {
    return "UTR_REJECTED";
  }

  const statusCode = data.StatusCode ?? data.statusCode ?? data.code;

  if (statusCode === 0 || statusCode === "0") {
    return "UTR_SUBMITTED";
  }

  if (statusCode === 1 || statusCode === "1") {
    return "UTR_ALREADY_INITIATED";
  }

  if (data.IsSuccess === true || data.isSuccess === true) {
    return "UTR_SUBMITTED";
  }

  const message = String(getManualDepositMessage(payload) || "").toLowerCase();

  if (message.includes("reject") || message.includes("invalid") || message.includes("fail")) {
    return "UTR_REJECTED";
  }

  return "UTR_SUBMITTED";
}

function getDepositInrPerUsd() {
  const rate = Number(process.env.DEPOSIT_INR_PER_USD || process.env.INR_PER_USD || 95.6);
  return Number.isFinite(rate) && rate > 0 ? rate : 95.6;
}

function getPayoutInrPerUsd() {
  const rate = Number(
    process.env.PAYOUT_INR_PER_USD ||
      process.env.INR_PER_USD ||
      process.env.DEPOSIT_INR_PER_USD ||
      95.6
  );

  return Number.isFinite(rate) && rate > 0 ? rate : 95.6;
}

function resolvePayoutAmounts(body) {
  const amountUsd = Number(body.amountUsd || body.usdAmount);

  if (Number.isFinite(amountUsd) && amountUsd > 0) {
    const usdToInrRate = getPayoutInrPerUsd();
    const amountInr = Math.round(amountUsd * usdToInrRate);

    return {
      amountInr,
      amountUsd: roundMoney(amountUsd),
      usdToInrRate,
      amountPaisa: amountInr * 100,
    };
  }

  const amountInr = Number(body.amount);

  return {
    amountInr,
    amountUsd: null,
    usdToInrRate: null,
    amountPaisa: Math.round(amountInr * 100),
  };
}

router.get("/deposit/config", (req, res) => {
  res.json({
    inrPerUsd: getDepositInrPerUsd(),
  });
});

router.post("/deposit", async (req, res) => {
  try {
    const { username, email, clientCode, mobile, amount } = req.body;

    const amountInr = Number(amount);
    const depositId = randomUUID();
    const paisa = Math.round(amountInr * 100);

    if (!username || !email || !mobile || !Number.isFinite(amountInr) || amountInr <= 0) {
      return res.status(400).json({ error: "Missing or invalid deposit details" });
    }

    await ensureDepositsTable();

    try {
      await validateCrmEmail(email);
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return res.status(404).json({
          error: "Email not found or no active USD eWallet deposit account",
        });
      }

      console.error("CRM EMAIL VALIDATION ERROR:", error.message);

      return res.status(502).json({
        error: "Unable to validate email right now. Please try again.",
      });
    }

    await pool.query(
      `INSERT INTO deposits
       (id, username, client_code, email, mobile, amount_inr, amount_paisa, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        depositId,
        username,
        clientCode,
        email,
        mobile,
        amountInr,
        paisa,
        "CREATED",
      ]
    );

    const pspResponse = await createPayin({
      depositId,
      paisa,
      username,
      clientCode,
      email,
      mobile,
    });

    const redirectUrl = getPayinRedirectUrl(pspResponse);
    const hostedToken = extractHostedToken(redirectUrl);
    const pspDepositId = getPspDepositId(pspResponse);

    if (!redirectUrl) {
      await pool.query(
        `UPDATE deposits
         SET status=$1, psp_response=$2, error_message=$3, updated_at=NOW()
         WHERE id=$4`,
        ["REQUEST_FAILED", pspResponse, "PSP did not return a hosted payment URL", depositId]
      );

      return res.status(502).json({ error: "PSP did not return payment details" });
    }

    let paymentDetails = null;

    try {
      paymentDetails = await fetchHostedPaymentDetails(redirectUrl);
      paymentDetails = {
        ...paymentDetails,
        transactionNo: paymentDetails.transactionNo || hostedToken,
        amount: paymentDetails.amount || amountInr,
      };
    } catch (error) {
      console.error("PAYMENT DETAILS FETCH ERROR:", error.message);

      await pool.query(
        `UPDATE deposits
         SET status=$1, hosted_url=$2, hosted_token=$3, psp_deposit_id=$4,
             psp_response=$5, error_message=$6, updated_at=NOW()
         WHERE id=$7`,
        [
          "DETAILS_FETCH_FAILED",
          redirectUrl,
          hostedToken,
          pspDepositId,
          pspResponse,
          error.message,
          depositId,
        ]
      );

      return res.status(502).json({
        depositId,
        error: "Payment link created, but payment details could not be loaded here.",
      });
    }

    await pool.query(
      `UPDATE deposits
       SET status=$1, hosted_url=$2, hosted_token=$3, psp_deposit_id=$4,
           psp_response=$5, payment_details=$6, error_message=NULL, updated_at=NOW()
       WHERE id=$7`,
      [
        "INITIATED",
        redirectUrl,
        hostedToken,
        pspDepositId,
        pspResponse,
        paymentDetails,
        depositId,
      ]
    );

    res.json({
      depositId,
      paymentDetails: getPublicPaymentDetails(paymentDetails),
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Deposit failed" });
  }
});

router.post("/deposit/:id/utr", async (req, res) => {
  try {
    await ensureDepositsTable();

    const utr = String(req.body.utr || "").replace(/\D/g, "");
    const flexibleUtr = req.body.flexibleUtr === true;

    if (flexibleUtr ? !/^\d+$/.test(utr) : !/^(\d{7}|\d{12}|\d{13}|\d{14})$/.test(utr)) {
      return res.status(400).json({
        error: flexibleUtr
          ? "Please enter a valid numeric UTR / bank reference"
          : "Please enter a valid 7, 12, 13, or 14 digit UTR / bank reference",
      });
    }

    const result = await pool.query(
      `SELECT * FROM deposits WHERE id=$1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Deposit not found" });
    }

    const deposit = result.rows[0];
    const transactionNo =
      deposit.hosted_token ||
      (deposit.payment_details && deposit.payment_details.transactionNo);

    if (!transactionNo) {
      return res.status(409).json({ error: "PSP transaction token is missing for this deposit" });
    }

    const paymentDetails = deposit.payment_details || {};
    const manualPaymentMasterId = Number(
      paymentDetails.manualPaymentMasterId || process.env.MANUAL_PAYMENT_MASTER_ID || 4908
    );
    const paymentMethod = Number(
      paymentDetails.paymentMethod || process.env.MANUAL_PAYMENT_METHOD || 9
    );
    const manualResponse = await submitManualDeposit({
      transactionNo,
      utr,
      amount: Number(deposit.amount_inr),
      manualPaymentMasterId,
      paymentMethod,
    });
    const status = normalizeManualDepositStatus(manualResponse);
    const manualMessage = getManualDepositMessage(manualResponse) || "UTR submitted successfully";
    const duplicateUtrMessage =
      "This UTR is already initiated or approved for another payment ticket. " +
      "Please contact support if the amount is not credited.";

    await pool.query(
      `UPDATE deposits
       SET status=$1, utr=$2, manual_deposit_response=$3, error_message=NULL, updated_at=NOW()
       WHERE id=$4`,
      [status, utr, manualResponse, req.params.id]
    );

    if (status === "UTR_REJECTED") {
      return res.status(422).json({
        error: manualMessage || "PSP rejected the deposit request",
      });
    }

    if (status === "UTR_ALREADY_INITIATED") {
      return res.status(409).json({
        error: duplicateUtrMessage,
        message: manualMessage,
        status,
      });
    }

    res.json({
      message: manualMessage,
      status,
      redirectUrl: process.env.RETURN_URL || null,
    });
  } catch (err) {
    const errorData = err.response ? err.response.data : { message: err.message };

    await pool.query(
      `UPDATE deposits
       SET status=$1, error_message=$2, manual_deposit_response=$3, updated_at=NOW()
       WHERE id=$4`,
      ["UTR_SUBMIT_FAILED", err.message, errorData, req.params.id]
    ).catch(() => {});

    console.error(err);
    res.status(502).json({
      error: "Unable to submit UTR to PSP",
    });
  }
});



async function sendToCrmProcessor({ email, transactionId, amount, utr }) {
  await axios.post(
    process.env.CRM_PROCESSOR_WEBHOOK_URL,
    {
      email,
      transactionId,
      amount,
      utr,
    },
    {
      headers: {
        "Content-Type": "application/json",
        privatekey: process.env.CRM_PROCESSOR_PRIVATE_KEY,
      },
      timeout: 15000,
    }
  );
}


router.post("/webhook/payin", async (req, res) => {
  try {
    if (req.headers.privatekey !== process.env.PSP_PRIVATE_KEY) {
      return res.json({ returnMessage: "Invalid Key", code: 1 });
    }

    const { TransactionId, Amount } = req.body;

    const result = await pool.query(
      `SELECT * FROM deposits WHERE id=$1`,
      [TransactionId]
    );

    if (result.rows.length === 0) {
      return res.json({ returnMessage: "Invalid Transaction", code: 1 });
    }

    const deposit = result.rows[0];

    if (Amount !== deposit.amount_paisa) {
      await pool.query(
        `UPDATE deposits SET status=$1 WHERE id=$2`,
        ["AMOUNT_MISMATCH", TransactionId]
      );
      return res.json({ returnMessage: "Amount mismatch", code: 1 });
    }

    const statusResponse = await checkStatus(TransactionId);
    const data = statusResponse.Result;

    if (data.StatusCode === 1 && data.IsSuccess) {
      await pool.query(
        `UPDATE deposits 
         SET status=$1, utr=$2, updated_at=NOW() 
         WHERE id=$3`,
        ["COMPLETED", data.Utr, TransactionId]
      );

await sendToCrmProcessor({
  email: deposit.email,
  transactionId: TransactionId,
  amount: Amount / 100,
  utr: data.Utr,
});

    } else {
      await pool.query(
        `UPDATE deposits SET status=$1 WHERE id=$2`,
        ["FAILED", TransactionId]
      );
    }

    return res.json({ returnMessage: "Processed", code: 0 });

  } catch (err) {
    console.error(err);
    return res.json({ returnMessage: "Server Error", code: 1 });
  }
});

router.get("/deposit/:id", async (req, res) => {
  await ensureDepositsTable();

  const result = await pool.query(
    `SELECT * FROM deposits WHERE id=$1`,
    [req.params.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ message: "Not found" });
  }

  res.json(serializeDeposit(result.rows[0]));
});

router.get("/admin/payins", requireAdmin, async (req, res) => {
  try {
    await ensureDepositsTable();

    const { startDate, endDate } = getDateRange(req);
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 10), 100);
    const offset = (page - 1) * limit;
    const search = String(req.query.search || "").trim();
    const statusFilter = String(req.query.status || "").trim();
    const baseWhere = ["updated_at BETWEEN $1 AND $2"];
    const baseValues = [startDate, endDate];

    if (search) {
      baseValues.push(`%${search}%`);
      baseWhere.push(
        `(id::text ILIKE $${baseValues.length}
          OR COALESCE(psp_deposit_id, '') ILIKE $${baseValues.length}
          OR COALESCE(hosted_token, '') ILIKE $${baseValues.length}
          OR COALESCE(username, '') ILIKE $${baseValues.length}
          OR COALESCE(email, '') ILIKE $${baseValues.length}
          OR COALESCE(mobile, '') ILIKE $${baseValues.length}
          OR COALESCE(utr, '') ILIKE $${baseValues.length})`
      );
    }

    const rowWhere = [...baseWhere];
    const rowValues = [...baseValues];
    const statusValues = getPayinStatusesForFilter(statusFilter);

    if (statusValues) {
      rowValues.push(statusValues);
      rowWhere.push(`UPPER(status) = ANY($${rowValues.length}::text[])`);
    }

    const whereSql = `WHERE ${rowWhere.join(" AND ")}`;
    const baseWhereSql = `WHERE ${baseWhere.join(" AND ")}`;
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM deposits ${whereSql}`,
      rowValues
    );
    const queryValues = [...rowValues, limit, offset];
    const result = await pool.query(
      `SELECT *
       FROM deposits
       ${whereSql}
       ORDER BY updated_at DESC
       LIMIT $${rowValues.length + 1}
       OFFSET $${rowValues.length + 2}`,
      queryValues
    );
    const summaryResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_count,
         COALESCE(SUM(amount_inr), 0)::numeric AS total_amount,
         COALESCE(SUM(CASE WHEN UPPER(status) IN ('COMPLETED','UTR_SUBMITTED','SUCCESS','DONE') THEN amount_inr ELSE 0 END), 0)::numeric AS success_amount,
         COALESCE(SUM(CASE WHEN UPPER(status) IN ('FAILED','FAIL','REQUEST_FAILED','DETAILS_FETCH_FAILED','UTR_REJECTED','UTR_SUBMIT_FAILED','AMOUNT_MISMATCH') THEN amount_inr ELSE 0 END), 0)::numeric AS failed_amount,
         COALESCE(SUM(CASE WHEN UPPER(status) IN ('CREATED','INITIATED','PENDING') THEN amount_inr ELSE 0 END), 0)::numeric AS pending_amount,
         COALESCE(SUM(CASE WHEN UPPER(status) NOT IN ('COMPLETED','UTR_SUBMITTED','SUCCESS','DONE','FAILED','FAIL','REQUEST_FAILED','DETAILS_FETCH_FAILED','UTR_REJECTED','UTR_SUBMIT_FAILED','AMOUNT_MISMATCH','CREATED','INITIATED','PENDING') THEN amount_inr ELSE 0 END), 0)::numeric AS incomplete_amount
       FROM deposits
       ${baseWhereSql}`,
      baseValues
    );
    const total = countResult.rows[0].total;
    const summary = summaryResult.rows[0];

    res.json({
      payins: result.rows.map(serializePayin),
      summary: {
        totalRecords: summary.total_count,
        totalAmount: roundMoney(summary.total_amount),
        successAmount: roundMoney(summary.success_amount),
        failedAmount: roundMoney(summary.failed_amount),
        pendingAmount: roundMoney(summary.pending_amount),
        incompleteAmount: roundMoney(summary.incomplete_amount),
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load payins" });
  }
});

router.get("/admin/reconciliation", requireAdmin, async (req, res) => {
  try {
    await ensureDepositsTable();
    await ensurePayoutsTable();

    const { startDate, endDate } = getDateRange(req);
    const depositRate = getCommissionRate("DEPOSIT_COMMISSION_RATE", 0.06);
    const withdrawRate = getCommissionRate("WITHDRAW_COMMISSION_RATE", 0.025);
    const settlement = Number(req.query.settlement || 0);
    const chargeback = Number(req.query.chargeback || 0);
    const depositStatuses = ["COMPLETED", "UTR_SUBMITTED", "SUCCESS", "DONE"];
    const payoutStatuses = ["SUCCESS", "COMPLETED", "DONE"];

    const depositResult = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_inr), 0)::numeric AS amount
       FROM deposits
       WHERE updated_at BETWEEN $1 AND $2
         AND UPPER(status) = ANY($3::text[])`,
      [startDate, endDate, depositStatuses]
    );
    const payoutResult = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS amount
       FROM payouts
       WHERE updated_at BETWEEN $1 AND $2
         AND UPPER(status) = ANY($3::text[])`,
      [startDate, endDate, payoutStatuses]
    );

    const depositAmount = Number(depositResult.rows[0].amount || 0);
    const withdrawAmount = Number(payoutResult.rows[0].amount || 0);
    const depositCommission = roundMoney(depositAmount * depositRate);
    const withdrawCommission = roundMoney(withdrawAmount * withdrawRate);
    const totalCommission = roundMoney(depositCommission + withdrawCommission);
    const currentBalance = roundMoney(
      depositAmount - withdrawAmount - totalCommission - settlement - chargeback
    );

    res.json({
      range: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      rates: {
        deposit: depositRate,
        withdraw: withdrawRate,
      },
      deposit: {
        count: depositResult.rows[0].count,
        amount: roundMoney(depositAmount),
        commission: depositCommission,
      },
      withdraw: {
        count: payoutResult.rows[0].count,
        amount: roundMoney(withdrawAmount),
        commission: withdrawCommission,
      },
      settlement: roundMoney(settlement),
      chargeback: roundMoney(chargeback),
      totalCommission,
      currentBalance,
      netBalance: currentBalance,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load reconciliation report" });
  }
});

router.get("/admin/payouts", requireAdmin, async (req, res) => {
  try {
    await ensurePayoutsTable();

    const { startDate, endDate } = getDateRange(req);
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 10), 100);
    const offset = (page - 1) * limit;
    const transactionId = String(req.query.transactionId || "").trim();
    const email = String(req.query.email || "").trim();
    const search = String(req.query.search || "").trim();
    const statusFilter = String(req.query.status || "").trim();
    const baseWhere = ["updated_at BETWEEN $1 AND $2"];
    const baseValues = [startDate, endDate];

    if (search) {
      baseValues.push(`%${search}%`);
      baseWhere.push(
        `(id::text ILIKE $${baseValues.length}
          OR COALESCE(beneficiary_name, '') ILIKE $${baseValues.length}
          OR COALESCE(email, '') ILIKE $${baseValues.length}
          OR COALESCE(phone, '') ILIKE $${baseValues.length}
          OR COALESCE(account_number, '') ILIKE $${baseValues.length}
          OR COALESCE(ifsc, '') ILIKE $${baseValues.length}
          OR COALESCE(bank_name, '') ILIKE $${baseValues.length}
          OR COALESCE(utr, '') ILIKE $${baseValues.length}
          OR COALESCE(order_id, '') ILIKE $${baseValues.length})`
      );
    }

    if (transactionId) {
      baseValues.push(`%${transactionId}%`);
      baseWhere.push(`id::text ILIKE $${baseValues.length}`);
    }

    if (email) {
      baseValues.push(`%${email}%`);
      baseWhere.push(`email ILIKE $${baseValues.length}`);
    }

    const rowWhere = [...baseWhere];
    const rowValues = [...baseValues];
    const statusValues = getPayoutStatusFilter(statusFilter);

    if (statusValues && statusValues.include) {
      rowValues.push(statusValues.include);
      rowWhere.push(`UPPER(status) = ANY($${rowValues.length}::text[])`);
    } else if (statusValues && statusValues.exclude) {
      rowValues.push(statusValues.exclude);
      rowWhere.push(`UPPER(status) <> ALL($${rowValues.length}::text[])`);
    }

    const whereSql = `WHERE ${rowWhere.join(" AND ")}`;
    const baseWhereSql = `WHERE ${baseWhere.join(" AND ")}`;
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM payouts ${whereSql}`,
      rowValues
    );
    const queryValues = [...rowValues, limit, offset];
    const result = await pool.query(
      `SELECT *
       FROM payouts
       ${whereSql}
       ORDER BY updated_at DESC
       LIMIT $${rowValues.length + 1}
       OFFSET $${rowValues.length + 2}`,
      queryValues
    );
    const summaryResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_count,
         COALESCE(SUM(amount), 0)::numeric AS total_amount,
         COALESCE(SUM(CASE WHEN UPPER(status) IN ('SUCCESS','COMPLETED','DONE') THEN amount ELSE 0 END), 0)::numeric AS success_amount,
         COALESCE(SUM(CASE WHEN UPPER(status) IN ('FAIL','FAILED','REQUEST_FAILED') THEN amount ELSE 0 END), 0)::numeric AS failed_amount,
         COALESCE(SUM(CASE WHEN UPPER(status) IN ('CREATED','INITIATED','PENDING') THEN amount ELSE 0 END), 0)::numeric AS pending_amount,
         COALESCE(SUM(CASE WHEN UPPER(status) NOT IN ('SUCCESS','COMPLETED','DONE','FAIL','FAILED','REQUEST_FAILED','CREATED','INITIATED','PENDING') THEN amount ELSE 0 END), 0)::numeric AS incomplete_amount
       FROM payouts
       ${baseWhereSql}`,
      baseValues
    );
    const total = countResult.rows[0].total;
    const summary = summaryResult.rows[0];

    res.json({
      payouts: result.rows.map(serializePayout),
      summary: {
        totalRecords: summary.total_count,
        totalAmount: roundMoney(summary.total_amount),
        successAmount: roundMoney(summary.success_amount),
        failedAmount: roundMoney(summary.failed_amount),
        pendingAmount: roundMoney(summary.pending_amount),
        incompleteAmount: roundMoney(summary.incomplete_amount),
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load payouts" });
  }
});

router.get("/admin/payouts/balance", requireAdmin, async (req, res) => {
  try {
    const balance = await checkPayoutBalance();
    res.json({ balance });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Unable to fetch payout balance" });
  }
});

router.post("/admin/payouts/refresh-pending", requireAdmin, async (req, res) => {
  try {
    await ensurePayoutsTable();

    const pending = await pool.query(
      `SELECT id, status
       FROM payouts
       WHERE UPPER(status) NOT IN ('SUCCESS','COMPLETED','DONE','FAIL','FAILED','REQUEST_FAILED')
       ORDER BY updated_at DESC
       LIMIT 100`
    );

    const ids = pending.rows.map((row) => row.id);

    if (ids.length === 0) {
      return res.json({ payouts: [] });
    }

    const statusResponses = await checkMultiplePayoutStatuses(ids);
    const responses = Array.isArray(statusResponses) ? statusResponses : [];
    const updated = [];

    for (const statusResponse of responses) {
      if (!statusResponse || !statusResponse.transactionID) {
        continue;
      }

      const pspStatus = normalizePayoutStatus(statusResponse, "PENDING");
      const meta = getPayoutMeta(statusResponse);

      const result = await pool.query(
        `UPDATE payouts
         SET status=$1, psp_status=$2, message=$3, code=$4, utr=$5, order_id=$6,
             status_response=$7, error_message=NULL, updated_at=NOW()
         WHERE id=$8
         RETURNING *`,
        [
          pspStatus,
          pspStatus,
          meta.message,
          meta.code,
          meta.utr,
          meta.orderId,
          statusResponse,
          statusResponse.transactionID,
        ]
      );

      if (result.rows[0]) {
        updated.push(serializePayout(result.rows[0]));
      }
    }

    res.json({ payouts: updated });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Unable to refresh pending payout statuses" });
  }
});

router.get("/admin/payouts/:id", requireAdmin, async (req, res) => {
  try {
    await ensurePayoutsTable();

    const result = await pool.query(
      `SELECT * FROM payouts WHERE id=$1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Payout not found" });
    }

    res.json({ payout: serializePayout(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load payout" });
  }
});

async function createPayoutFromRequest(req, res) {
  await ensurePayoutsTable();

  const accountNumber = String(req.body.accountNumber || "").trim();
  const ifsc = String(req.body.ifsc || "").trim().toUpperCase();
  const bankName = String(req.body.bankName || "State Bank Of India").trim();
  const { amountInr, amountUsd, usdToInrRate, amountPaisa } = resolvePayoutAmounts(req.body);
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const phone = String(req.body.phone || "").replace(/\D/g, "");
  const transactionID = randomUUID();

  if (!accountNumber || !ifsc || !bankName || !name || !email || !amountInr || amountInr <= 0) {
    return res.status(400).json({ error: "Missing or invalid payout details" });
  }

  await pool.query(
    `INSERT INTO payouts
     (id, account_number, ifsc, bank_name, amount, amount_usd, usd_to_inr_rate, amount_paisa, beneficiary_name, email, phone, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      transactionID,
      accountNumber,
      ifsc,
      bankName,
      amountInr,
      amountUsd,
      usdToInrRate,
      amountPaisa,
      name,
      email,
      phone,
      "CREATED",
    ]
  );

  try {
    const pspResponse = await createPayout({
      accountNumber,
      ifsc,
      bankName,
      amountPaisa,
      name,
      email,
      phone,
      transactionID,
    });

    const pspStatus = normalizePayoutStatus(pspResponse, "INITIATED");
    const meta = getPayoutMeta(pspResponse);

    const result = await pool.query(
      `UPDATE payouts
       SET status=$1, psp_status=$2, message=$3, code=$4, order_id=$5, psp_response=$6, updated_at=NOW()
       WHERE id=$7
       RETURNING *`,
      [pspStatus, pspStatus, meta.message, meta.code, meta.orderId, pspResponse, transactionID]
    );

    res.status(201).json({ payout: serializePayout(result.rows[0]) });
  } catch (err) {
    const errorData = err.response ? err.response.data : { message: err.message };

    const result = await pool.query(
      `UPDATE payouts
       SET status=$1, error_message=$2, psp_response=$3, updated_at=NOW()
       WHERE id=$4
       RETURNING *`,
      ["REQUEST_FAILED", err.message, errorData, transactionID]
    );

    res.status(502).json({
      error: "Payout request failed",
      payout: serializePayout(result.rows[0]),
    });
  }
}

router.post("/admin/payouts", requireAdmin, createPayoutFromRequest);

router.post("/payout/request", requirePayoutApiKey, createPayoutFromRequest);

router.get("/payout/:id", requirePayoutApiKey, async (req, res) => {
  try {
    await ensurePayoutsTable();

    const result = await pool.query(
      `SELECT * FROM payouts WHERE id=$1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Payout not found" });
    }

    res.json({ payout: serializePayout(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load payout" });
  }
});

router.post("/admin/payouts/:id/refresh", requireAdmin, async (req, res) => {
  try {
    await ensurePayoutsTable();

    const existing = await pool.query(
      `SELECT * FROM payouts WHERE id=$1`,
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Payout not found" });
    }

    const statusResponse = await checkPayoutStatus(req.params.id);
    const pspStatus = normalizePayoutStatus(statusResponse, existing.rows[0].status);
    const meta = getPayoutMeta(statusResponse);

    const result = await pool.query(
      `UPDATE payouts
       SET status=$1, psp_status=$2, message=$3, code=$4, utr=$5, order_id=$6,
           status_response=$7, error_message=NULL, updated_at=NOW()
       WHERE id=$8
       RETURNING *`,
      [pspStatus, pspStatus, meta.message, meta.code, meta.utr, meta.orderId, statusResponse, req.params.id]
    );

    res.json({ payout: serializePayout(result.rows[0]) });
  } catch (err) {
    const errorData = err.response ? err.response.data : { message: err.message };

    const result = await pool.query(
      `UPDATE payouts
       SET error_message=$1, status_response=$2, updated_at=NOW()
       WHERE id=$3
       RETURNING *`,
      [err.message, errorData, req.params.id]
    );

    res.status(502).json({
      error: "Unable to refresh payout status",
      payout: result.rows[0] ? serializePayout(result.rows[0]) : null,
    });
  }
});

router.post("/webhook/payout", async (req, res) => {
  try {
    if (req.headers.privatekey !== getPayoutWebhookKey()) {
      return res.json({ message: "Invalid Key", code: "FAILED" });
    }

    await ensurePayoutsTable();

    const transactionID = req.body.transactionID;

    if (!transactionID) {
      return res.json({ message: "Missing transactionID", code: "FAILED" });
    }

    const status = normalizePayoutStatus(req.body, "PENDING");
    const meta = getPayoutMeta(req.body);

    const result = await pool.query(
      `UPDATE payouts
       SET status=$1, psp_status=$2, message=$3, code=$4, utr=$5, order_id=$6,
           webhook_response=$7, status_response=$7, error_message=NULL, updated_at=NOW()
       WHERE id=$8
       RETURNING *`,
      [status, status, meta.message, meta.code, meta.utr, meta.orderId, req.body, transactionID]
    );

    if (result.rows.length === 0) {
      return res.json({ message: "TransactionNotFound", code: "FAILED" });
    }

    return res.json({ message: "Processed", code: "SUCCESS" });
  } catch (err) {
    console.error(err);
    return res.json({ message: "Server Error", code: "FAILED" });
  }
});

module.exports = router;


