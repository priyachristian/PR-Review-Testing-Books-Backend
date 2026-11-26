# bsynk-backend

### New Company Defaults

When a new company is registered via `POST /v1/auth/add-company`, the system automatically creates the following records and settings.

- **Division**: name `default`
- **Branch**: name `default`
- **Warehouse**: name `default`, `warehouseId: 1`
- **Bank (Petty Cash)**:
  - `accountType`: `Petty Cash`
  - `accountName`: `PETTY CASH`
  - `currency`: `INR`
  - `openingBalance`: `0.0`
- **Role**: `Admin` with full permissions on all modules (permissions: `view/create/edit/delete = true` for each module)
- **User**: the creator user is set `isAdmin: true`, marked verified, and assigned to the `Admin` role (status `active`)
- **ModuleSettings**: one record per module with default numbering configuration
  - `useCustomPrefix: true`
  - `startingSequence: "00001"`
  - `nextSequence: "00001"`
  - Default prefixes by module:

    | Module                      | Prefix  |
    | --------------------------- | ------- |
    | `ITEM`                      | `I-`    |
    | `QUOTATION`                 | `QUO-`  |
    | `SALES_ORDER`               | `SO-`   |
    | `DELIVERY_CHALLAN`          | `DC-`   |
    | `INVOICE`                   | `INV-`  |
    | `PAYMENT_RECEIVED`          | `PAYR-` |
    | `CREDIT_NOTE`               | `CN-`   |
    | `PURCHASE_ORDER`            | `PO-`   |
    | `GRPO`                      | `GRPO-` |
    | `BILL`                      | `BILL-` |
    | `PAYMENT_MADE`              | `PAYM-` |
    | `DEBIT_NOTE`                | `DN-`   |
    | `EXPENSE`                   | `EX-`   |
    | `SPLIT_BILL`                | `SPLI-` |
    | `SPLIT_INVOICE`             | `SPLI-` |
    | `SPLIT_PAYMENT_RECEIVED`    | `SPLI-` |
    | `SPLIT_PAYMENT_MADE`        | `SPLI-` |
    | `RECURRING_INVOICE`         | `RECU-` |
    | `RECURRING_BILL`            | `RECU-` |
    | `RECURRING_EXPENSE`         | `RECU-` |
    | `RECURRING_ACCOUNT_EXPENSE` | `RECU-` |
    | `ACCOUNT_EXPENSE`           | `ACCO-` |

  - For any other modules in `utils/enum.js -> MODULE_NAMES` that are not listed above (e.g., `SPLIT_INVOICE`, `SPLIT_BILL`, `SPLIT_PAYMENT_RECEIVED`, `SPLIT_PAYMENT_MADE`, `RECURRING_INVOICE`, `RECURRING_BILL`, `RECURRING_EXPENSE`, `RECURRING_ACCOUNT_EXPENSE`, `ACCOUNT_EXPENSE`), the prefix defaults to the first 4 characters of the module name plus a dash. Examples: `SPLI-`, `RECU-`, `ACCO-`.

- **CompanySettings** (initial):
  - `additionalChargesConfig: []`
  - `inventoryConfig`:
    - `salesFlowStockCheckSource: ["INVOICE"]`
    - `salesFlowStockReserveSource: ["INVOICE"]`
    - `purchaseFlowStockAddSource: "BILL"`

### Optional Seed Data (available endpoints)

These are not created automatically on company creation, but endpoints exist to seed sensible defaults.

- **Item Units** (`POST /v1/itemUnit/seedDefaultunits`)
  - Values: `KGS (kg)`, `LBS (lb)`, `MGS (mg)`, `MLT (ml)`, `MTR (m)`, `PCS (pc)`

- **Chart of Accounts** (`GET /v1/account/categories`, `GET /v1/account/dropdown`, `POST /v1/account`)
  - Parents with default children:
    - `Other Current Asset`: `Advance Tax`, `Employee Advance`, `Prepaid Expenses`, `TDS Receivable`
    - `Fixed Asset`: `Furniture and Equipment`
    - `Other Current Liability`: `Employee Reimbursements`, `Opening Balance Adjustments`, `TDS Payable`, `Unearned Revenue`
    - `Equity`: `Capital Stock`, `Distributions`, `Dividends Paid`, `Drawings`
    - `Income`: `Discount`, `General Income`, `Interest Income`, `Late Fee Income`, `Other Charges`, `Sales`, `Shipping Charge`
    - `Expense`: `Advertising And Marketing`, `Automobile Expense`, `Bad Debt`, `Bank Fees and Charges`, `Consultant Expense`
    - `Cost of Goods Sold`: `Cost of Goods Sold`, `Job Costing`, `Labor`, `Materials`, `Subcontractor`
    - `Other`: (no children)

- **Taxes (TDS)** (`POST /v1/tax/seed`)
  - Values:
    - `Commission or Brokerage` — 5% — `Section 194 H`
    - `Commission or Brokerage (Reduced)` — 3.75% — `Section 194 H`
    - `Dividend` — 10% — `Section 194`
    - `Dividend (Reduced)` — 7.5% — `Section 194`
    - `Other Interest than securities` — 10% — `Section 194 A`
    - `Other Interest than securities (Reduced)` — 7.5% — `Section 194 A`
    - `Payment of contractors for Others` — 2% — `Section 194 C`
    - `Payment of contractors for Others (Reduced)` — 1.5% — `Section 194 C`
    - `Payment of contractors HUF/Indiv` — 1% — `Section 194 C`
    - `Payment of contractors HUF/Indiv (Reduced)` — 0.75% — `Section 194 C`
    - `Professional Fees` — 10% — `Section 194 J`
    - `Professional Fees (Reduced)` — 7.5% — `Section 194 J`
    - `Rent on land or furniture etc` — 10% — `Section 194 I`
    - `Rent on land or furniture etc (Reduced)` — 7.5% — `Section 194 I`
    - `Technical Fees (2%)` — 2% — `Section 194 J`

Notes:

- Module list is defined in `utils/enum.js` as `MODULE_NAMES`. Module master records should exist in the database; they are queried during company creation to build the `Admin` role permissions.
- The `purchaseFlowStockAddSource` in the initial `CompanySettings` is set to `BILL` (last write wins). You can later manage more detailed company settings through company profile APIs.
