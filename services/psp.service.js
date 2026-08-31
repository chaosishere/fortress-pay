const axios = require("axios");

function getPspBaseUrl() {
  return (process.env.PSP_URL || "https://lobby.dxbpay.me").replace(/\/+$/, "");
}

function getPayinClientCode(clientCode) {
  return process.env.PSP_CLIENT_CODE || clientCode || "fort";
}

function extractHostedToken(url) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).searchParams.get("token");
  } catch (_) {
    const match = String(url).match(/[?&]token=([^&]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

function parseJsonField(value) {
  if (!value) {
    return null;
  }

  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function keyValueArrayToObject(value) {
  const parsed = parseJsonField(value);
  const output = {};

  if (Array.isArray(parsed)) {
    parsed.forEach((item) => {
      if (item && typeof item.key !== "undefined") {
        output[String(item.key).trim().toLowerCase()] = item.value;
      }
    });
  }

  return output;
}

function getMappedValue(map, labels) {
  for (const label of labels) {
    const value = map[String(label).toLowerCase()];

    if (value !== null && typeof value !== "undefined" && String(value).trim()) {
      return String(value).trim();
    }
  }

  return null;
}

function isPlaceholderValue(value) {
  return /^(manual|null|undefined|n\/a|na|--|-)?$/i.test(String(value || "").trim());
}

function isValidUpiId(value) {
  return /^[a-z0-9._-]+@[a-z0-9.-]+$/i.test(String(value || "").trim());
}

function buildUpiIntent({ amount, upiId, accountHolder, rechargeReqId }) {
  if (!amount || !upiId) {
    return null;
  }

  const params = new URLSearchParams({
    ver: "01",
    mode: "15",
    am: Number(amount).toFixed(2),
    mam: Number(amount).toFixed(2),
    cu: "INR",
    pa: upiId,
  });

  if (accountHolder) {
    params.set("pn", accountHolder);
  }

  if (rechargeReqId) {
    params.set("tr", `TRNS${rechargeReqId}`);
    params.set("tn", `TRNS${rechargeReqId}`);
  }

  return `upi://pay?${params.toString()}`;
}

async function generateUpiQrCode({
  amount,
  upiId,
  accountHolder,
  rechargeReqId,
  transactionNote,
}) {
  if (!isValidUpiId(upiId) || !accountHolder) {
    return { qrCode: null, intent: null };
  }

  const { UPIQR } = await import("@adityavijay21/upiqr");
  const { qr, intent } = await new UPIQR()
    .set({
      upiId,
      name: accountHolder,
      amount: amount || undefined,
      transactionId: rechargeReqId ? `TRNS${rechargeReqId}` : undefined,
      transactionRef: rechargeReqId ? `TRNS${rechargeReqId}` : undefined,
      transactionNote: transactionNote || (rechargeReqId ? `TRNS${rechargeReqId}` : undefined),
      currency: "INR",
    })
    .setOptions({
      outputType: "dataURL",
      width: 260,
      margin: 1,
      errorCorrectionLevel: "M",
    })
    .generate();

  return {
    qrCode: qr,
    intent,
  };
}

function getPayoutBaseUrl() {
  return process.env.PSP_PAYOUT_URL || process.env.PAYOUT_API_URL || "https://apipayout.dxbpay.me";
}

function getPayoutPrivateKey() {
  const privateKey = process.env.PSP_PAYOUT_PRIVATE_KEY || process.env.PAYOUT_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("PSP payout private key is not configured");
  }

  return privateKey;
}

exports.createPayin = async ({
  depositId,
  paisa,
  username,
  clientCode,
  email,
  mobile,
}) => {
  try {
    const response = await axios.post(
      `${getPspBaseUrl()}/api/payment/request`,
      {
        Amount: paisa,
        TransactionId: depositId,
        ClientUsername: username,
        ClientCode: getPayinClientCode(clientCode),
        Description: "",
        Email: email,
        MobileNo: mobile,
        ReturnUrl: process.env.RETURN_URL,
        Udf1: "",
        Udf2: "",
        Udf3: "",
        Udf4: ""
      },
      {
        headers: {
          PrivateKey: process.env.PSP_PRIVATE_KEY,
          "Content-Type": "application/json"
        },
        timeout: 5000
      }
    );

    return response.data;

  } catch (error) {
  console.log("PSP ERROR MESSAGE:", error.message);

  if (error.response) {
    console.log("PSP STATUS:", error.response.status);
  } else {
    console.log("NO RESPONSE FROM PSP");
  }
  throw error;
}
};

exports.checkStatus = async (transactionId) => {
  const response = await axios.get(
    `${getPspBaseUrl()}/api/payment/status?TransactionId=${transactionId}`,
    {
      headers: {
        PrivateKey: process.env.PSP_PRIVATE_KEY,
      },
    }
  );

  return response.data;
};

exports.extractHostedToken = extractHostedToken;

exports.submitManualDeposit = async ({
  transactionNo,
  utr,
  amount,
  manualPaymentMasterId,
  paymentMethod,
}) => {
  const response = await axios.post(
    `${getPspBaseUrl()}/api/ManualPayment/ManualDeposit`,
    {
      TransactionNo: transactionNo,
      UTRTransactionNo: utr,
      Amount: amount,
      FrontImageBase64: null,
      FrontImageExtn: null,
      PaymentGatewayCredentialId: null,
      PaymentMethod: paymentMethod,
      WithdrawRequestId: null,
      IsAutoWithdrawalAllow: null,
      IsPartialWithdrawalAllow: null,
      ManualPaymentMasterId: manualPaymentMasterId,
    },
    {
      headers: {
        ...(process.env.PSP_PRIVATE_KEY ? { PrivateKey: process.env.PSP_PRIVATE_KEY } : {}),
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  return response.data;
};

exports.fetchHostedPaymentDetails = async (paymentUrl) => {
  if (!paymentUrl) {
    throw new Error("PSP payment URL is missing");
  }

  const token = extractHostedToken(paymentUrl);

  if (!token) {
    throw new Error("PSP hosted token is missing from payment URL");
  }

  const response = await axios.get(
    `${getPspBaseUrl()}/api/Dashboard/GetPaymentInformationList/${encodeURIComponent(token)}`,
    {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  const payload = response.data || {};
  const status = payload.Status || payload.status;

  if (status && Number(status.code) !== 0) {
    throw new Error(status.returnMessage || status.message || "PSP payment information request failed");
  }

  const paymentInfo = Array.isArray(payload.GetPaymentInformationList)
    ? payload.GetPaymentInformationList[0] || {}
    : {};
  const credentialResponse = payload.CredentialResponse || {};

  if (!payload.CredentialResponse || !Array.isArray(payload.GetPaymentInformationList)) {
    throw new Error("PSP payment information response did not include payment details");
  }

  const paymentMap = {
    ...keyValueArrayToObject(credentialResponse.Credential),
    ...keyValueArrayToObject(credentialResponse.UpiIntent),
  };
  const transactionDetail = payload.transactionDetail || {};
  const amount = Number(transactionDetail.Amount || paymentInfo.Amount || 0) || null;
  const rawUpiId = getMappedValue(paymentMap, ["upi id", "upi", "vpa"]);
  const upiId = isValidUpiId(rawUpiId) && !isPlaceholderValue(rawUpiId) ? rawUpiId : null;
  const accountHolder = getMappedValue(paymentMap, ["holder name", "account holder", "beneficiary name", "holder"]);
  const rechargeReqId = credentialResponse.RechargeReqId || credentialResponse.rechargeReqId || null;
  const bankName = getMappedValue(paymentMap, ["bank name", "bank"]);
  const accountNumber = getMappedValue(paymentMap, ["account no", "account number", "a/c no", "ac no"]);
  const ifsc = getMappedValue(paymentMap, ["ifsc code", "ifsc"]);
  const fallbackIntent = buildUpiIntent({
    amount,
    upiId,
    accountHolder,
    rechargeReqId,
  });
  let qrResult = { qrCode: null, intent: null };

  if (!upiId && (!bankName || !accountNumber || !ifsc)) {
    throw new Error("PSP payment information response did not include UPI or bank details");
  }

  try {
    qrResult = await generateUpiQrCode({
      amount,
      upiId,
      accountHolder,
      rechargeReqId,
    });
  } catch (error) {
    console.error("UPI QR GENERATION ERROR:", error.message);
  }

  return {
    transactionNo: token,
    orderId: token,
    clientTxnId: transactionDetail.ClientTxnId || paymentInfo.ClientTxnId || null,
    amount,
    manualPaymentMasterId:
      paymentInfo.ManualPaymentMasterId ||
      paymentInfo.manualPaymentMasterId ||
      credentialResponse.ManualPaymentMasterId ||
      credentialResponse.manualPaymentMasterId ||
      null,
    paymentMethod: paymentInfo.PaymentMethod || null,
    paymentGatewayCredentialId:
      paymentInfo.PaymentGatewayCredentialId || credentialResponse.PaymentGatewayCredentialId || null,
    rechargeReqId,
    upiId,
    upiIntent: qrResult.intent || fallbackIntent,
    bankName,
    accountHolder,
    accountNumber,
    ifsc,
    qrCode: qrResult.qrCode,
  };
};

exports.createPayout = async ({
  accountNumber,
  ifsc,
  bankName,
  amountPaisa,
  name,
  email,
  phone,
  transactionID,
  udf1 = "",
  udf2 = "",
  udf3 = "",
  udf4 = "",
}) => {
  try {
    const response = await axios.post(
      `${getPayoutBaseUrl()}/payout/request`,
      {
        accountNumber,
        ifsc,
        bankName,
        amount: amountPaisa,
        name,
        email,
        phone,
        transactionID,
        udf1,
        udf2,
        udf3,
        udf4,
      },
      {
        headers: {
          PrivateKey: getPayoutPrivateKey(),
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    return response.data;
  } catch (error) {
    console.log("PAYOUT ERROR MESSAGE:", error.message);

    if (error.response) {
      console.log("PAYOUT STATUS:", error.response.status);
      console.log("PAYOUT DATA:", error.response.data);
    } else {
      console.log("NO RESPONSE FROM PAYOUT PSP");
    }

    throw error;
  }
};

exports.checkPayoutStatus = async (transactionID) => {
  const statusUrl = process.env.PSP_PAYOUT_STATUS_URL || process.env.PAYOUT_STATUS_URL;
  const url = statusUrl
    ? statusUrl.replace("{transactionID}", encodeURIComponent(transactionID))
    : `${getPayoutBaseUrl()}/payout/status`;

  const response = await axios.post(
    url,
    { transactionID },
    {
      headers: {
        PrivateKey: getPayoutPrivateKey(),
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  return response.data;
};

exports.checkMultiplePayoutStatuses = async (transactionIDs) => {
  const response = await axios.post(
    `${getPayoutBaseUrl()}/payout/multistatus`,
    { transactionID: transactionIDs },
    {
      headers: {
        PrivateKey: getPayoutPrivateKey(),
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );

  return response.data;
};

exports.checkPayoutBalance = async () => {
  const response = await axios.get(`${getPayoutBaseUrl()}/payout/balance`, {
    headers: {
      PrivateKey: getPayoutPrivateKey(),
    },
    timeout: 15000,
  });

  return response.data;
};


exports.validateCrmEmail = async (email) => {
  const response = await axios.post(
    process.env.CRM_PROCESSOR_VALIDATE_EMAIL_URL,
    { email },
    {
      headers: {
        "Content-Type": "application/json",
        privatekey: process.env.CRM_PROCESSOR_PRIVATE_KEY,
      },
      timeout: 15000,
    }
  );

  return response.data;
};
