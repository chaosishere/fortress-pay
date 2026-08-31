# New CRM Payment API

This API lets the new CRM create a PSP-hosted INR payment and redirect the customer directly to the PSP URL.

## Endpoint

`POST /api/new-crm/payment`

The endpoint is disabled unless:

```env
NEW_CRM_INTEGRATION_ENABLED=true
```

Authenticate the request with the existing admin key:

```http
privatekey: ADMIN_PANEL_KEY_VALUE
Content-Type: application/json
```

## Request Body

```json
{
  "transactionId": "CRM-TRANSACTION-ID",
  "username": "BANK-ACCOUNT-HOLDER-NAME",
  "email": "REGISTERED-EMAIL-ADDRESS",
  "mobile": "10-DIGIT-MOBILE-NUMBER",
  "amount": 10000
}
```

Rules:

- `transactionId` must be unique per CRM payment.
- `username`, `email`, `mobile`, and `amount` are validated before contacting the PSP.
- `amount` is already INR.
- The processor converts INR to paisa only with `round(amount * 100)`.
- Do not send callback URLs. The processor uses `NEW_CRM_WEBHOOK_URL` from the server environment.

## Success Response

The success response contains only the PSP-hosted payment URL:

```json
{
  "paymentUrl": "https://lobby.dxbpay.me/?token=..."
}
```

The CRM should redirect the customer to `paymentUrl`.

## Idempotency

The processor uses `transactionId` as the external reference.

If the same `transactionId` is sent again with identical `username`, `email`, `mobile`, and `amount`, the processor returns the original PSP link:

```json
{
  "paymentUrl": "https://lobby.dxbpay.me/?token=..."
}
```

If the same `transactionId` is sent again with different details, the processor returns:

```http
409 Conflict
```

```json
{
  "error": "transactionId already exists with different payment details"
}
```

## Webhook Callback To New CRM

When the PSP payin webhook reaches the processor, transactions created through this API are sent to:

```env
NEW_CRM_WEBHOOK_URL=
```

The outgoing callback is authenticated with:

```http
privatekey: NEW_CRM_WEBHOOK_PRIVATE_KEY_VALUE
Content-Type: application/json
```

Payload:

```json
{
  "transactionId": "CRM-TRANSACTION-ID",
  "status": "completed",
  "utr": "BANK-REFERENCE"
}
```

`utr` may be `null`.

Normalized statuses:

- `pending`
- `completed`
- `failed`
- `cancelled`
- `expired`

Terminal callbacks are guarded so duplicate PSP webhooks do not send duplicate confirmations for the same stored transaction.

## Environment Variables

```env
NEW_CRM_INTEGRATION_ENABLED=false
NEW_CRM_WEBHOOK_URL=
NEW_CRM_WEBHOOK_PRIVATE_KEY=
DEFAULT_PAYMENT_PAGE_ENABLED=true
```

- `NEW_CRM_INTEGRATION_ENABLED`: enables only `POST /api/new-crm/payment` when set to `true`.
- `NEW_CRM_WEBHOOK_URL`: fixed server-side callback URL for the new CRM.
- `NEW_CRM_WEBHOOK_PRIVATE_KEY`: private key sent to the new CRM callback endpoint.
- `DEFAULT_PAYMENT_PAGE_ENABLED`: disables existing public payment pages when set to `false`; does not disable the new CRM API, admin, webhooks, payout APIs, or health endpoint.

## Postman Test

1. Set environment variables in Postman:

```text
baseUrl=https://pay.fortressfx.com
adminKey=YOUR_ADMIN_PANEL_KEY
```

2. Create a `POST` request:

```text
{{baseUrl}}/api/new-crm/payment
```

3. Add headers:

```http
privatekey: {{adminKey}}
Content-Type: application/json
```

4. Add body:

```json
{
  "transactionId": "CRM-TEST-{{$timestamp}}",
  "username": "Test User",
  "email": "test@example.com",
  "mobile": "9876543210",
  "amount": 10000
}
```

5. Expected response:

```json
{
  "paymentUrl": "https://lobby.dxbpay.me/?token=..."
}
```

6. Send the exact same body again. It should return the same `paymentUrl` and should not create another PSP payment.

7. Send the same `transactionId` with a changed `amount` or `email`. It should return `409 Conflict`.

## Local Testing Notes

For local testing, enable the API in `.env`:

```env
NEW_CRM_INTEGRATION_ENABLED=true
NEW_CRM_WEBHOOK_URL=https://crm.example.com/webhooks/payments
NEW_CRM_WEBHOOK_PRIVATE_KEY=replace-me
```

Restart the Node process after changing env values.
