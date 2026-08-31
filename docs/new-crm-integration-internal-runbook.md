# New CRM Integration Internal Runbook

This document is for FortressFX / processor operators and developers.

## Files Changed

- `routes/payment.routes.js`
- `server.js`
- `.env.example`
- `test/new-crm.test.js`
- `docs/new-crm-integration-for-crm-team.md`
- `docs/new-crm-payment-api.md`

## Endpoint

```http
POST /api/new-crm/payment
```

Authentication uses the existing admin key:

```http
x-admin-key: ADMIN_PANEL_KEY
```

The endpoint is disabled by default and only works when:

```env
NEW_CRM_INTEGRATION_ENABLED=true
```

## Required New Env Variables

```env
NEW_CRM_INTEGRATION_ENABLED=false
NEW_CRM_WEBHOOK_URL=
NEW_CRM_WEBHOOK_PRIVATE_KEY=
DEFAULT_PAYMENT_PAGE_ENABLED=true
```

Meaning:

- `NEW_CRM_INTEGRATION_ENABLED`: enables only the new CRM API.
- `NEW_CRM_WEBHOOK_URL`: fixed server-side webhook URL for payment status callbacks to the new CRM.
- `NEW_CRM_WEBHOOK_PRIVATE_KEY`: secret sent to new CRM in callback header `privatekey`.
- `DEFAULT_PAYMENT_PAGE_ENABLED`: controls existing public payment pages only.

Do not change production env values until the integration is approved for production testing.

## Existing Env Variables Still Used

- `ADMIN_PANEL_KEY`: authenticates incoming new CRM requests.
- `PSP_URL`: PSP base URL.
- `PSP_PRIVATE_KEY`: PSP payin request and PSP payin webhook key.
- `PSP_CLIENT_CODE`: PSP payin client code. Defaults to `fort` when unset.
- `RETURN_URL`: still used by existing PSP integration and legacy payment flows.
- `DATABASE_URL`: Postgres connection.
- `CRM_PROCESSOR_WEBHOOK_URL`: legacy CRM callback URL.
- `CRM_PROCESSOR_PRIVATE_KEY`: legacy CRM callback key.
- `CRM_PROCESSOR_VALIDATE_EMAIL_URL`: legacy public deposit email validation.

The new CRM flow does not use the legacy email validation call and does not change old CRM behavior.

## Amount Handling

The new CRM submits INR:

```json
{
  "amount": 10000
}
```

The processor converts only to paisa for PSP:

```text
amountPaisa = round(amount * 100)
```

No USD-to-INR conversion is applied in this flow.

Existing exchange-rate env variables stay unchanged for the existing deposit and payout flows.

## Database Mapping

New nullable columns are added to `deposits`:

- `external_source`
- `external_transaction_id`
- `external_request`
- `external_callback_status`
- `external_callback_sent_at`
- `external_callback_response`
- `external_callback_error`

New CRM deposits are stored with:

```text
external_source = new_crm
external_transaction_id = CRM transactionId
client_code = new_crm
```

Database uniqueness:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_new_crm_transaction_unique
ON deposits (external_transaction_id)
WHERE external_source = 'new_crm';
```

This does not affect legacy deposits because legacy rows do not use `external_source = 'new_crm'`.

## Idempotency Logic

For `POST /api/new-crm/payment`:

- Same `transactionId` and identical request details returns the stored `hosted_url`.
- Same `transactionId` with changed details returns `409 Conflict`.
- A Postgres advisory transaction lock is used around creation to prevent duplicate PSP payments during concurrent retries.

## PSP Creation Flow

1. Validate request.
2. Insert `deposits` row with status `CREATED`.
3. Call existing `createPayin`.
4. Extract PSP hosted URL.
5. Store:
   - `hosted_url`
   - `hosted_token`
   - `psp_deposit_id`
   - `psp_response`
   - status `INITIATED`
6. Return only:

```json
{
  "paymentUrl": "ACTUAL-PSP-PAYMENT-LINK"
}
```

No internal IDs, bank details, UPI details, status, amount, exchange rate, or Fortress payment page URL are returned.

## PSP Webhook Flow

PSP payin webhook remains:

```http
POST /api/webhook/payin
```

For legacy deposits:

- Existing legacy CRM webhook behavior remains unchanged.

For new CRM deposits:

- Processor detects `external_source = new_crm`.
- Status is normalized to:
  - `pending`
  - `completed`
  - `failed`
  - `cancelled`
  - `expired`
- Terminal statuses trigger the new CRM callback.
- Duplicate terminal callbacks are blocked using `external_callback_status`.

New CRM callback payload:

```json
{
  "transactionId": "CRM-TRANSACTION-ID",
  "status": "completed",
  "utr": "BANK-REFERENCE"
}
```

## Public Payment Page Flag

`DEFAULT_PAYMENT_PAGE_ENABLED=false` disables:

- `/deposit`
- `/jay/deposit`
- `/b2core/deposit`
- `/b2core/jay/deposit`
- `/deposit.html`
- `/jay-deposit.html`

It does not disable:

- `/api/new-crm/payment`
- `/api/webhook/payin`
- `/webhook/payout`
- `/api` admin/report routes
- `/health`

Restart the Node process after changing this env value.

## Test Commands

Run unit tests:

```bash
npm test
```

Syntax checks:

```bash
node --check routes/payment.routes.js
node --check server.js
```

## Postman Internal Smoke Test

Enable on staging:

```env
NEW_CRM_INTEGRATION_ENABLED=true
NEW_CRM_WEBHOOK_URL=https://staging-new-crm.example.com/payment/webhook
NEW_CRM_WEBHOOK_PRIVATE_KEY=staging-shared-secret
DEFAULT_PAYMENT_PAGE_ENABLED=true
```

Restart the app.

Create payment:

```http
POST https://pay.fortressfx.com/api/new-crm/payment
x-admin-key: ADMIN_PANEL_KEY
Content-Type: application/json
```

Body:

```json
{
  "transactionId": "CRM-STAGE-001",
  "username": "Test User",
  "email": "test@example.com",
  "mobile": "9876543210",
  "amount": 10000
}
```

Expected:

```json
{
  "paymentUrl": "https://lobby.dxbpay.me/?token=..."
}
```

Verify in DB:

```sql
SELECT id, external_source, external_transaction_id, amount_inr, amount_paisa, status, hosted_url
FROM deposits
WHERE external_transaction_id = 'CRM-STAGE-001';
```

## Rollback

Fast rollback without code change:

```env
NEW_CRM_INTEGRATION_ENABLED=false
```

Restart the Node process. This disables only the new CRM API.
