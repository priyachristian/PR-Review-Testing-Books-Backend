const ACCOUNT_MESSAGES = {
  CREATE_SUCCESS: 'Account created successfully',
  CREATE_FAILURE: 'Failed to create account',
  FETCH_SUCCESS: 'Accounts fetched successfully',
  FETCH_FAILURE: 'Failed to fetch accounts',
  FETCH_ONE_SUCCESS: 'Account fetched successfully',
  FETCH_ONE_FAILURE: 'Account not found',
  UPDATE_SUCCESS: 'Account updated successfully',
  UPDATE_FAILURE: 'Failed to update account',
  DELETE_SUCCESS: 'Account deleted successfully',
  DELETE_FAILURE: 'Failed to delete account',
  DROPDOWN_FETCH_SUCCESS: 'Accounts fetched successfully',
  LEDGER_FETCH_SUCCESS: 'Account ledger fetched successfully',
  LEDGER_FETCH_FAILURE: 'Unable to fetch the account ledger',
  DOCUMENT_JOURNAL_FETCH_SUCCESS: 'Document journal fetched successfully',
  DOCUMENT_JOURNAL_FETCH_FAILURE: 'Unable to fetch the document journal',
  DROPDOWN_FETCH_FAILURE: 'Failed to fetch accounts dropdown',
  CATEGORIES_FETCH_SUCCESS: 'Account categories fetched successfully',
  CATEGORIES_FETCH_FAILURE: 'Failed to fetch account categories',
  COMPANY_ID_REQUIRED: 'Company ID is required',
  SYSTEM_DELETE_FORBIDDEN: 'System accounts cannot be deleted',
  SYSTEM_PARENT_FORBIDDEN: 'System accounts cannot be parent accounts',
  BANK_DELETED_FROM_BANKING: 'Bank accounts are deleted from the Banking module',
  PARENT_NOT_FOUND: 'Parent account not found',
  PARENT_SAME_CATEGORY: 'Parent account must belong to the same category',
  PARENT_NO_NESTING: 'Sub accounts cannot be parents (maximum one level of nesting)',
  OWN_PARENT_FORBIDDEN: 'Account cannot be its own parent',
  HAS_CHILDREN_CATEGORY: 'Remove or reassign sub accounts before changing the category',
  HAS_CHILDREN_DEACTIVATE: 'Cannot deactivate an account that has sub accounts',
  HAS_CHILDREN_SUB_ACCOUNT: 'Cannot make an account with sub accounts into a sub account',
  HAS_CHILDREN_DELETE: 'Cannot delete an account that has sub accounts',
  HAS_TRANSACTIONS_DELETE: 'Cannot delete an account that already carries posted transactions',
  USED_BY_ITEMS_DELETE: 'Cannot delete an account that items are using for sales, purchase or inventory',
  USED_BY_CONTACTS_DELETE: 'Cannot delete an account that customers or vendors are using as their control account',
  REMOVE_OPENING_BALANCE_FIRST: 'Remove the opening balance before changing this account to that category',
  INVALID_CATEGORY: 'The selected account category is not valid',
  SUB_ACCOUNT_NOT_ALLOWED: 'Sub accounts are not allowed for this category',
  OPENING_BALANCE_NOT_APPLICABLE: 'Opening balance cannot be recorded for this account type',
  DUPLICATE_ACCOUNT_NAME: 'An account with this name already exists in the selected category',
};

const BANK_MESSAGES = {
  CREATE_SUCCESS: 'Bank created successfully',
  CREATE_FAILURE: 'Failed to create Bank',
  FETCH_SUCCESS: 'Banks fetched successfully',
  FETCH_FAILURE: 'Failed to fetch banks',
  UPDATE_SUCCESS: 'Bank updated successfully',
  UPDATE_FAILURE: 'Failed to update bank',
  DELETE_SUCCESS: 'Bank deleted successfully',
  DELETE_FAILURE: 'Failed to delete bank',
  TRANSFER_AMOUNT_FAILURE: 'Failed to transfer amount',
  TRANSFER_AMOUNT: 'Amount transfer request created successfully',
  FETCH_ONE_NOT_FOUND: 'Bank not found',
  SYSTEM_BANK_DELETE_FORBIDDEN: 'System accounts like Petty Cash cannot be deleted',
  HAS_TRANSACTIONS_DELETE: 'You cannot delete this account as you have associated it with the transactions',
  TRANSACTION_SUCCESS: 'Transaction successful',
  TRANSACTION_NOT_FOUND: 'Transaction not found',
  INVALID_CURRENCY: 'Invalid currency for this company',
  ACCOUNT_NO_EXISTS: 'Bank with this Account No already exists',
  BANK_EXISTS: 'Bank already exists',
  PETTY_CASH_EXISTS: 'A Petty Cash account already exists for this company. Edit it from Banking.',
  TRANSFER_SAME_ACCOUNT: 'Transfer From and Transfer To must be different accounts',
  WITHDRAW_SAME_ACCOUNT: 'Withdraw From and Withdraw To must be different accounts',
  DEPOSIT_SAME_ACCOUNT: 'Deposit From and Deposit To must be different accounts',
  EXCHANGE_RATE_REQUIRED: 'Enter an exchange rate to transfer between accounts in different currencies',
  COUNTERPART_ACCOUNT_NOT_FOUND: 'The selected account was not found or is inactive',
  COUNTERPART_CATEGORY_NOT_ALLOWED: 'cannot be used for this bank transaction',
  TRANSACTION_ALREADY_APPROVED: 'Transaction is already approved',
  TRANSACTION_ALREADY_REJECTED: 'Transaction is already rejected',
  TRANSACTION_ALREADY_CANCELLED: 'Transaction is already cancelled',
  TRANSACTION_FAILURE: 'Transaction failed',
  FETCH_TRANSACTIONS_SUCCESS: 'Transactions fetched successfully',
  FETCH_TRANSACTIONS_FAILURE: 'Failed to fetch transactions',
  APPROVE_TRANSACTION_FAILURE: 'Failed to approve transaction',
  CANCEL_TRANSACTION_FAILURE: 'Failed to cancel transaction',
  REJECT_TRANSACTION_FAILURE: 'Failed to reject transaction',
  APPROVE_TRANSACTION_SUCCESS: 'Transaction approved successfully',
  CANCEL_TRANSACTION_SUCCESS: 'Transaction cancelled successfully',
  REJECT_TRANSACTION_SUCCESS: 'Transaction rejected successfully',
};

const BILL_MESSAGES = {
  CREATE_SUCCESS: 'Bill Created Successfully',
  CREATE_FAILURE: 'Failed to create bill',
  FETCH_SUCCESS: 'Bills processed successfully',
  FETCH_FAILURE: 'Failed to retrieve bills',
  FETCH_ONE_SUCCESS: 'Bill fetched Successfully',
  FETCH_ONE_FAILURE: 'Bill not found',
  UPDATE_SUCCESS: 'Bill updated successfully',
  UPDATE_FAILURE: 'Failed to update bill',
  DELETE_SUCCESS: 'Bill deleted successfully',
  DELETE_FAILURE: 'Failed to delete bill',
  PENDING_FETCH_SUCCESS: 'Pending bills fetched successfully',
  PENDING_FETCH_FAILURE: 'Failed to fetch pending bills',
  FETCH_DROPDOWN_SUCCESS: 'Bill dropdown fetched successfully',
  FETCH_DROPDOWN_FAILURE: 'Failed to fetch bill dropdown',
  UPDATE_STATUS_SUCCESS: 'Bill status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update bill status',
  PAYMENT_HISTORY_FETCH_SUCCESS: 'Payment history fetched successfully',
  PAYMENT_HISTORY_FETCH_FAILURE: 'Failed to fetch payment history',
  APPLY_CREDIT_SUCCESS: 'Credit applied successfully',
  APPLY_CREDIT_FAILURE: 'Failed to apply credit',
  AUTO_MAP_OB_SUCCESS: 'Opening balance auto-mapped successfully',
  AUTO_MAP_OB_FAILURE: 'Failed to auto-map opening balance',

  REMOVE_OB_APPLICATION_SUCCESS: 'Opening balance payment entry removed successfully',
  REMOVE_OB_APPLICATION_FAILURE: 'Failed to remove opening balance payment entry',
};

const BRANCH_MESSAGES = {
  CREATE_SUCCESS: 'Branch created successfully',
  CREATE_FAILURE: 'Failed to create Branch',
  FETCH_SUCCESS: 'Branches fetched successfully',
  FETCH_FAILURE: 'Failed to fetch branches',
  UPDATE_SUCCESS: 'Branch updated successfully',
  UPDATE_FAILURE: 'Failed to update Branch',
  DELETE_SUCCESS: 'Branch deleted successfully',
  DELETE_FAILURE: 'Failed to delete Branch',
  DELETE_IN_USE: 'Cannot delete this branch because it is referenced in one or more existing documents.',
  HAS_WAREHOUSES: 'Cannot delete this branch because it has one or more warehouses. Please delete the warehouses first.',
  DROPDOWN_FETCH_SUCCESS: 'Branch dropdown fetched successfully',
  DROPDOWN_FETCH_FAILURE: 'Failed to fetch branch dropdown',
  DIVISION_ID_REQUIRED: 'divisionId query parameter is required',
  FETCH_ONE_NOT_FOUND: 'Branch not found',
  UPDATE_STATUS_SUCCESS: 'Branch status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update branch status',
};

const CREDIT_NOTE_MESSAGES = {
  CREATE_SUCCESS: 'Credit Note created successfully',
  CREATE_FAILURE: 'Failed to create credit note',
  FETCH_SUCCESS: 'Credit Notes processed successfully',
  FETCH_FAILURE: 'Failed to retrieve credit notes',
  FETCH_ONE_SUCCESS: 'Credit Note fetched successfully',
  FETCH_ONE_FAILURE: 'Credit Note not found',
  NOT_FOUND: 'Credit Note not found',
  UPDATE_SUCCESS: 'Credit Note updated successfully',
  UPDATE_FAILURE: 'Failed to update credit note',
  DELETE_SUCCESS: 'Credit Note deleted successfully',
  DELETE_FAILURE: 'Failed to delete credit note',
  DELETE_RESTRICTED_REJECTION_ORDER:
    'This credit note cannot be deleted because its linked rejection order has been sorted or devolved',
  APPLY_SUCCESS: 'Credit Note applied successfully',
  APPLY_FAILURE: 'Failed to apply credit note',
  REFUND_SUCCESS: 'Refund processed successfully',
  REFUND_FAILURE: 'Failed to process refund',
  REFUND_DELETE_SUCCESS: 'Refund deleted successfully',
  REFUND_DELETE_FAILURE: 'Failed to delete refund',
  HAS_REFUNDS: 'Cannot cancel this credit note because it has existing refunds. Please delete all refunds first.',
  REFUND_INVALID_STATUS: 'Refunds can only be added to open or partially used credit notes.',
};

const CUSTOMER_MESSAGES = {
  NOT_ACTIVE_IN_BRANCH: 'Customer is not active in this branch',
  VENDOR_NOT_ACTIVE_IN_BRANCH: 'Vendor is not active in this branch',
  CONTROL_ACCOUNT_NOT_FOUND: 'Accounts Receivable/Payable system account not found',
  ACCOUNT_TYPE_NOT_ALLOWED: 'This account type cannot be used for this business partner',
  ACCOUNT_TYPE_LOCKED: 'The account type cannot be changed after transactions have been posted for this business partner',
  CREATE_SUCCESS: 'Customer created successfully',
  CREATE_FAILURE: 'An error occurred while creating the customer',
  FETCH_ALL_SUCCESS: 'Customers retrieved successfully',
  FETCH_ALL_FAILURE: 'An error occurred while retrieving customers',
  FETCH_ALL_NO_RESULTS: 'No customers found for the provided companyId',
  FETCH_VENDOR_SUCCESS: 'Vendor retrieved successfully',
  FETCH_VENDOR_FAILURE: 'An error occurred while retrieving vendors',
  FETCH_CUSTOMER_SUCCESS: 'Customer retrieved successfully',
  FETCH_CUSTOMER_FAILURE: 'An error occurred while retrieving customers',
  UPDATE_SUCCESS: 'Customer updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the customer',
  DELETE_SUCCESS: 'Customer deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the customer',
  DELETE_IN_USE_CUSTOMER: 'Cannot delete this customer because it is referenced in one or more existing documents.',
  DELETE_IN_USE_VENDOR: 'Cannot delete this vendor because it is referenced in one or more existing documents.',
  COMPANY_ID_REQUIRED: 'companyId query parameter is required',
  FETCH_ONE_NOT_FOUND: 'Customer not found',
  UPDATE_ADDRESS_STATUS_SUCCESS: 'Customer shipping address status updated successfully',
  UPDATE_ADDRESS_STATUS_FAILURE: 'Failed to update customer shipping address status',
  ADDRESS_NOT_FOUND: 'Customer shipping address not found',
  FETCH_ADDRESS_SUCCESS: 'Customer shipping addresses fetched successfully',
  FETCH_ADDRESS_FAILURE: 'Failed to fetch customer shipping addresses',
  ADD_ADDRESS_SUCCESS: 'Customer shipping address added successfully',
  ADD_ADDRESS_FAILURE: 'Failed to add customer shipping address',
  ADD_BILLING_ADDRESS_SUCCESS: 'Customer billing address added successfully',
  BILLING_ADDRESS_EXISTS: 'Customer already has a billing address. Edit the existing one instead.',
  UPDATE_ADDRESS_SUCCESS: 'Customer shipping address updated successfully',
  UPDATE_ADDRESS_FAILURE: 'Failed to update customer shipping address',
  FETCH_BUSINESS_PARTNER_TEAM_SUCCESS: 'Business partner team fetched successfully',
  FETCH_BUSINESS_PARTNER_TEAM_FAILURE: 'Failed to fetch business partner team',
  ADD_BUSINESS_PARTNER_TEAM_SUCCESS: 'Business partner team member added successfully',
  ADD_BUSINESS_PARTNER_TEAM_FAILURE: 'Failed to add business partner team member',
  UPDATE_BUSINESS_PARTNER_TEAM_SUCCESS: 'Business partner team member updated successfully',
  UPDATE_BUSINESS_PARTNER_TEAM_FAILURE: 'Failed to update business partner team member',
  DELETE_BUSINESS_PARTNER_TEAM_SUCCESS: 'Business partner team member deleted successfully',
  DELETE_BUSINESS_PARTNER_TEAM_FAILURE: 'Failed to delete business partner team member',
  BUSINESS_PARTNER_TEAM_NOT_FOUND: 'Business partner team member not found',
  UPDATE_STATUS_SUCCESS: 'Customer status updated successfully',
  UPDATE_STATUS_FAILURE: 'An error occurred while updating customer status',
  FETCH_PORTAL_CUSTOMERS_SUCCESS: 'Portal customers fetched successfully',
  FETCH_PORTAL_CUSTOMERS_FAILURE: 'Failed to fetch portal customers',
  FETCH_PORTAL_CUSTOMERS_NOT_FOUND: 'No portal customers found for the provided filters',
  FETCH_360_ANALYSIS_SUCCESS: 'Customer 360 analysis fetched successfully',
  FETCH_360_ANALYSIS_FAILURE: 'Failed to fetch customer 360 analysis',
  FETCH_CREDIT_DASHBOARD_SUCCESS: 'Customer credit dashboard fetched successfully',
  FETCH_CREDIT_DASHBOARD_FAILURE: 'Failed to fetch customer credit dashboard',
  FETCH_CREDIT_OVERVIEW_SUCCESS: 'Credit overview fetched successfully',
  FETCH_CREDIT_OVERVIEW_FAILURE: 'Failed to fetch credit overview',
  FETCH_CREDIT_UTILIZATION_SUCCESS: 'Credit utilization fetched successfully',
  FETCH_CREDIT_UTILIZATION_FAILURE: 'Failed to fetch credit utilization',
  FETCH_OVER_LIMIT_CUSTOMERS_SUCCESS: 'Over limit customers fetched successfully',
  FETCH_OVER_LIMIT_CUSTOMERS_FAILURE: 'Failed to fetch over limit customers',
  RESEND_PORTAL_INVITE_SUCCESS: 'Portal invite sent successfully',
  RESEND_PORTAL_INVITE_FAILURE: 'Failed to resend portal invite',
  BULK_CREATE_SUCCESS: 'Records added successfully',
  BULK_CREATE_FAILURE: 'An error occurred',
  BULK_VERIFY_SUCCESS: 'Bulk customers verified successfully',
  BULK_VERIFY_FAILURE: 'Failed to verify bulk customers',
  BULK_ADD_OPENING_BALANCE_SUCCESS: 'Customer branch opening balances added successfully',
  BULK_ADD_OPENING_BALANCE_FAILURE: 'Failed to add customer branch opening balances',
  BULK_VERIFY_OPENING_BALANCE_SUCCESS: 'Customer branch opening balances verified successfully',
  BULK_VERIFY_OPENING_BALANCE_FAILURE: 'Failed to verify customer branch opening balances',
  VERIFICATION_NOT_FOUND: 'No verification request found for this customer',
  VERIFICATION_ALREADY_PROCESSED: 'This verification request has already been processed',
  ACCEPT_VERIFICATION_SUCCESS: 'Customer verification accepted successfully',
  ACCEPT_VERIFICATION_FAILURE: 'Failed to accept customer verification',
  REJECT_VERIFICATION_SUCCESS: 'Customer verification rejected successfully',
  REJECT_VERIFICATION_FAILURE: 'Failed to reject customer verification',
};

const DELIVERY_CHALLAN_MESSAGES = {
  CREATE_SUCCESS: 'Delivery Challan created successfully',
  CREATE_FAILURE: 'Failed to create delivery challan',

  FETCH_ALL_SUCCESS: 'Delivery Challans processed successfully',
  FETCH_ALL_FAILURE: 'Failed to retrieve delivery challans',

  FETCH_ONE_SUCCESS: 'Delivery Challan fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to retrieve delivery challan',
  FETCH_ONE_NOT_FOUND: 'Delivery Challan not found',

  UPDATE_SUCCESS: 'Delivery Challan updated successfully',
  UPDATE_FAILURE: 'Failed to update delivery challan',

  UPDATE_STATUS_SUCCESS: 'Delivery Challan status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update delivery challan status',

  DELETE_SUCCESS: 'Delivery Challan deleted successfully',
  DELETE_FAILURE: 'Failed to delete delivery challan',

  STOCK_TRANSFER_LOCATION_INVALID: label => `${label} does not belong to the selected division and branch`,
  STOCK_TRANSFER_LOCATION_NOT_FOUND: label => `${label} not found`,
  STOCK_TRANSFER_TOGGLE_LOCKED: 'The internal stock transfer option cannot be changed after the delivery challan is created',
  STOCK_TRANSFER_ADDRESS_REQUIRED: (side, warehouseName) =>
    `Add the street, city, state and PIN code of the ${side} warehouse${warehouseName ? ` ${warehouseName}` : ''} (All Master > Warehouse) to use it in an internal stock transfer`,
  STOCK_TRANSFER_SAME_PINCODE: pinCode =>
    `The From and To warehouses have the same PIN code (${pinCode}). An internal stock transfer must move goods between two different locations.`,
  STOCK_TRANSFER_CUSTOMER_ACCOUNT: 'Select a customer whose Account Type is Branch / Divisions for an internal stock transfer',
  STOCK_TRANSFER_STOCK_USED: (challanNo, warehouseName) =>
    `The stock moved by ${challanNo} to ${warehouseName || 'the To warehouse'} has already been used, so the transfer cannot be reversed`,
  STOCK_TRANSFER_HAS_INVOICE: invoiceNos =>
    `Cannot reverse the stock transfer because an invoice has been created from it: ${invoiceNos}`,
  STOCK_TRANSFER_HAS_EWAY_BILL: eWayBillNo => `Cancel the e-way bill ${eWayBillNo} before reversing the stock transfer`,
  EWAY_BILL_NOT_ALLOWED: 'Mark the delivery challan as Sent before generating its e-way bill',
  HAS_ACTIVE_EWAY_BILL: (eWayBillNo, action) => `Cancel the e-way bill ${eWayBillNo} before ${action} this delivery challan`,
  INVOICE_MIXED_CHALLANS: 'Internal stock transfer and regular delivery challans cannot be converted into the same invoice',
  INVOICE_TRANSFER_LOCATIONS_DIFFER:
    'Internal stock transfer delivery challans from different locations cannot be converted into the same invoice',
  INVOICE_EWAY_BILL_ON_CHALLAN: (challanNo, eWayBillNo) =>
    `E-way bill ${eWayBillNo} is already active on delivery challan ${challanNo}. Cancel it there to generate one for this invoice.`,
};

const DIVISION_MESSAGES = {
  CREATE_SUCCESS: 'Division created successfully',
  CREATE_FAILURE: 'Failed to create Division',

  FETCH_ALL_SUCCESS: 'Divisions fetched successfully',
  FETCH_ALL_FAILURE: 'An error occurred while fetching divisions',

  FETCH_DROPDOWN_SUCCESS: 'Division dropdown fetched successfully',
  FETCH_DROPDOWN_FAILURE: 'An error occurred while fetching division dropdown',

  UPDATE_SUCCESS: 'Division updated successfully',
  UPDATE_FAILURE: 'Failed to update Division',

  DELETE_SUCCESS: 'Division deleted successfully',
  DELETE_FAILURE: 'Failed to delete Division',
  DELETE_IN_USE: 'Cannot delete this division because it is referenced in one or more existing documents.',
  HAS_CHILDREN: 'Cannot delete this division because it has one or more branches or warehouses. Please delete them first.',
  FETCH_ONE_NOT_FOUND: 'Division not found',

  UPDATE_STATUS_SUCCESS: 'Division status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update division status',
};

const EXPENSE_MESSAGES = {
  CREATE_SUCCESS: 'Expense created successfully',
  CREATE_FAILURE: 'An error occurred while adding the expense',

  FETCH_ALL_SUCCESS: 'Expenses retrieved successfully',
  FETCH_ALL_FAILURE: 'An error occurred while retrieving expenses',
  FETCH_ALL_NOT_FOUND: 'No expenses found for the provided filters',
  FETCH_ONE_NOT_FOUND: 'Expense not found',
  UPDATE_SUCCESS: 'Expense updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the expense',
  UPDATE_NOT_FOUND: 'Expense not found or update failed',

  DELETE_SUCCESS: 'Expense deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the expense',
  DELETE_NOT_FOUND: 'Expense not found or deletion failed',

  BILLABLE_PARTY_REQUIRED: 'Billable is only available for a customer or vendor',
  PAID_THROUGH_REQUIRED: 'Please select the paid through account',
  SETTLED_LOCKED: 'This expense has an associated payment or settlement. Remove it before deleting.',
};

const INVENTORY_ADJUSTMENT_MESSAGES = {
  CREATE_SUCCESS: 'Inventory adjustment created successfully',
  CREATE_FAILURE: 'Failed to create inventory adjustment',
  FETCH_LIST_SUCCESS: 'Inventory adjustments fetched successfully',
  FETCH_LIST_FAILURE: 'Failed to fetch inventory adjustments',
  FETCH_ONE_SUCCESS: 'Inventory adjustment fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch inventory adjustment',
  FETCH_ONE_NOT_FOUND: 'Inventory adjustment not found',
  APPROVE_SUCCESS: 'Inventory adjustment approved successfully',
  APPROVE_FAILURE: 'Failed to approve inventory adjustment',
  REJECT_SUCCESS: 'Inventory adjustment rejected successfully',
  REJECT_FAILURE: 'Failed to reject inventory adjustment',
  UPDATE_SUCCESS: 'Inventory adjustment updated successfully',
  UPDATE_FAILURE: 'Failed to update inventory adjustment',
  DUPLICATE_ITEM:
    'An item can appear only once in an inventory adjustment. Merge the repeated lines, or adjust the item in a separate adjustment',
};

const INVENTORY_TRANSFER_MESSAGES = {
  CREATE_SUCCESS: 'Stock transfer requested successfully',
  CREATE_FAILURE: 'Failed to request stock transfer',
  FETCH_LIST_SUCCESS: 'Transfer stock requests fetched successfully',
  FETCH_LIST_FAILURE: 'Failed to fetch transfer stock requests',
  FETCH_ONE_SUCCESS: 'Inventory transfer request fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch inventory transfer request',
  FETCH_ONE_NOT_FOUND: 'Inventory transfer request not found',
  APPROVE_SUCCESS: 'Transfer request approved and stock transferred',
  APPROVE_FAILURE: 'Failed to approve transfer request',
  REJECT_SUCCESS: 'Transfer request rejected',
  REJECT_FAILURE: 'Failed to reject transfer request',
  ITEM_NOT_FOUND: 'Item not found',
  FROM_WAREHOUSE_NOT_FOUND: 'From warehouse not found',
  TO_WAREHOUSE_NOT_FOUND: 'To warehouse not found',
  ONLY_PENDING_CAN_APPROVE: 'Only pending requests can be approved',
  ONLY_PENDING_CAN_REJECT: 'Only pending requests can be rejected',
  SAME_WAREHOUSE_ERROR: 'Source and destination warehouse must be different',
};

const INVENTORY_LOGS_MESSAGES = {
  FETCH_ALL_SUCCESS: 'Inventory logs fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch inventory logs',
  FETCH_ONE_SUCCESS: 'Inventory log fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch inventory log',
};

const ITEM_BATCH_MESSAGES = {
  FETCH_LIST_SUCCESS: 'Item batches fetched successfully',
  FETCH_LIST_FAILURE: 'Failed to fetch item batches',
  FETCH_ONE_SUCCESS: 'Item batch fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch item batch',
  FETCH_ONE_NOT_FOUND: 'Item batch not found',
};

const INVOICE_MESSAGES = {
  CREATE_SUCCESS: 'Invoice created successfully',
  CREATE_FAILURE: 'Failed to create invoice',

  FETCH_ALL_SUCCESS: 'Invoices retrieved successfully',
  FETCH_ALL_FAILURE: 'Failed to retrieve invoices',

  FETCH_ONE_SUCCESS: 'Invoice fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch invoice',
  FETCH_ONE_NOT_FOUND: 'Invoice not found',

  UPDATE_SUCCESS: 'Invoice updated successfully',
  UPDATE_FAILURE: 'Failed to update invoice',

  DELETE_SUCCESS: 'Invoice deleted successfully',
  DELETE_FAILURE: 'Failed to delete invoice',

  PENDING_FETCH_SUCCESS: 'Pending invoices retrieved successfully',
  PENDING_FETCH_FAILURE: 'Failed to retrieve pending invoices',

  FETCH_DROPDOWN_SUCCESS: 'Invoice dropdown fetched successfully',
  FETCH_DROPDOWN_FAILURE: 'Failed to fetch invoice dropdown',

  UPDATE_STATUS_SUCCESS: 'Invoice status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update invoice status',

  GENERATE_E_INVOICE_SUCCESS: 'E-Invoice generated successfully',
  GENERATE_E_INVOICE_FAILURE: 'Failed to generate E-Invoice',

  GENERATE_E_WAY_BILL_SUCCESS: 'E-Way Bill generated successfully',
  GENERATE_E_WAY_BILL_FAILURE: 'Failed to generate E-Way Bill',

  REFETCH_E_INVOICE_SUCCESS: 'E-Invoice details fetched successfully',
  FETCH_GST_DOCUMENT_OPTIONS_SUCCESS: 'E-Invoice and E-Way Bill options fetched successfully',
  FETCH_GST_DOCUMENT_OPTIONS_FAILURE: 'Failed to fetch E-Invoice and E-Way Bill options',
  REFETCH_E_INVOICE_FAILURE: 'Failed to fetch E-Invoice details',

  REFETCH_E_WAY_BILL_SUCCESS: 'E-Way Bill details fetched successfully',
  REFETCH_E_WAY_BILL_FAILURE: 'Failed to fetch E-Way Bill details',

  CANCEL_E_INVOICE_SUCCESS: 'E-Invoice cancelled successfully',
  CANCEL_E_INVOICE_FAILURE: 'Failed to cancel E-Invoice',

  CANCEL_E_WAY_BILL_SUCCESS: 'E-Way Bill cancelled successfully',
  CANCEL_E_WAY_BILL_FAILURE: 'Failed to cancel E-Way Bill',

  FETCH_PAYMENT_HISTORY_SUCCESS: 'Payment history fetched successfully',
  FETCH_PAYMENT_HISTORY_FAILURE: 'Failed to fetch payment history',

  GENERATE_ONLY_E_WAY_BILL_SUCCESS: 'E-Way Bill generated successfully',
  GENERATE_ONLY_E_WAY_BILL_FAILURE: 'Failed to generate E-Way Bill',

  APPLY_CREDIT_SUCCESS: 'Credit applied successfully',
  APPLY_CREDIT_FAILURE: 'Failed to apply credit',
  AUTO_MAP_OB_SUCCESS: 'Opening balance auto-mapped successfully',
  AUTO_MAP_OB_FAILURE: 'Failed to auto-map opening balance',

  REMOVE_OB_APPLICATION_SUCCESS: 'Opening balance payment entry removed successfully',
  REMOVE_OB_APPLICATION_FAILURE: 'Failed to remove opening balance payment entry',
};

const ITEM_MESSAGES = {
  CREATE_SUCCESS: 'Item created successfully',
  CREATE_FAILURE: 'Failed to create item',
  FETCH_ALL_SUCCESS: 'Items retrieved successfully',
  FETCH_ALL_FAILURE: 'Failed to retrieve items',
  FETCH_DROPDOWN_SUCCESS: 'Items for dropdown retrieved successfully',
  FETCH_DROPDOWN_FAILURE: 'Failed to retrieve items for dropdown',
  FETCH_ONE_SUCCESS: 'Item retrieved successfully',
  FETCH_ONE_FAILURE: 'Failed to retrieve item',
  FETCH_ONE_NOT_FOUND: 'Item not found',
  UPDATE_SUCCESS: 'Item updated successfully',
  UPDATE_FAILURE: 'Failed to update item',
  DELETE_SUCCESS: 'Item deleted successfully',
  DELETE_FAILURE: 'Failed to delete item',
  DELETE_IN_USE: 'Cannot delete this item because it is referenced in one or more existing documents.',
  FETCH_INVENTORY_DETAILS_SUCCESS: 'Item inventory details fetched successfully',
  FETCH_INVENTORY_DETAILS_FAILURE: 'Failed to fetch item inventory details',
  FETCH_INVENTORY_BATCHES_SUCCESS: 'Item inventory batches fetched successfully',
  FETCH_INVENTORY_BATCHES_FAILURE: 'Failed to fetch item inventory batches',
  FETCH_INVENTORY_BATCH_SUCCESS: 'Item inventory batch details fetched successfully',
  FETCH_INVENTORY_BATCH_FAILURE: 'Failed to fetch item inventory batch details',
  INVENTORY_BATCH_NOT_FOUND: 'Item inventory batch not found',
  BULK_CREATE_SUCCESS: 'Bulk items created successfully',
  BULK_CREATE_FAILURE: 'Failed to create bulk items',
  BULK_VERIFY_SUCCESS: 'Bulk items verified successfully',
  BULK_VERIFY_FAILURE: 'Failed to verify bulk items',
  FETCH_INVENTORY_STATUS_SUCCESS: 'Inventory status fetched successfully',
  FETCH_INVENTORY_STATUS_FAILURE: 'Failed to fetch inventory status',
  ADD_STOCK_SUCCESS: 'Stock added successfully',
  ADD_STOCK_FAILURE: 'Failed to add stock',
  TRANSFER_STOCK_SUCCESS: 'Stock transferred successfully',
  TRANSFER_STOCK_FAILURE: 'Failed to transfer stock',
  FETCH_PRODUCTION_DATA_SUCCESS: 'Production data fetched successfully',
  FETCH_PRODUCTION_DATA_FAILURE: 'Failed to fetch production data',
  BOM_DROPDOWN_SUCCESS: 'Item details fetched successfully',
  BOM_DROPDOWN_FAILURE: 'Failed to fetch item detail',
  ITEM_HISTORY_SUCCESS: 'Item history fetched successfully',
  ITEM_HISTORY_FAILURE: 'Failed to fetch item history',
  ITEM_TRANSACTIONS_SUCCESS: 'Item transactions fetched successfully',
  ITEM_TRANSACTIONS_FAILURE: 'Failed to fetch item transactions',
  TRANSFER_STOCK_REQUEST_SUCCESS: 'Stock transfer requested successfully',
  TRANSFER_STOCK_REQUEST_FAILURE: 'Failed to request stock transfer',
  GET_TRANSFER_REQUESTS_SUCCESS: 'Transfer stock requests fetched successfully',
  GET_TRANSFER_REQUESTS_FAILURE: 'Failed to fetch transfer stock requests',
  APPROVE_TRANSFER_SUCCESS: 'Transfer request approved and stock transferred',
  APPROVE_TRANSFER_FAILURE: 'Failed to approve transfer request',
  REJECT_TRANSFER_SUCCESS: 'Transfer request rejected',
  REJECT_TRANSFER_FAILURE: 'Failed to reject transfer request',
  AVAILABLE_STOCK_SUCCESS: 'Available stock retrieved successfully',
  AVAILABLE_STOCK_FAILURE: 'Failed to retrieve available stock',
  UPDATE_ITEM_STATUS_SUCCESS: 'Item status updated successfully',
  UPDATE_ITEM_STATUS_FAILURE: 'Failed to update item status',
  GET_ITEMS_USED_IN_SUCCESS: 'Items fetched successfully',
  GET_ITEMS_USED_IN_FAILURE: 'Failed to fetch items using this raw material',
  EXPORT_INVENTORY_STOCK_SUCCESS: 'Inventory stock exported successfully',
  EXPORT_INVENTORY_STOCK_FAILURE: 'Failed to export inventory stock',
  CREATE_PRODUCTION_DATA_SUCCESS: 'Production data created successfully',
  CREATE_PRODUCTION_DATA_FAILURE: 'Failed to create production data',
  PENDING_PURCHASE_ORDER_QTY_SUCCESS: 'Pending purchase order quantity retrieved successfully',
  PENDING_PURCHASE_ORDER_QTY_FAILURE: 'Failed to retrieve pending purchase order quantity',
  SALES_ACCOUNT_LOCKED: 'The Sales Account cannot be changed because this item has already been used in sales transactions.',
  PURCHASE_ACCOUNT_LOCKED:
    'The Purchase Account cannot be changed because this item has already been used in purchase transactions.',
  INVENTORY_ACCOUNT_LOCKED:
    'The Inventory Account cannot be changed because this item has inventory transactions or stock on hand.',
  TRACK_INVENTORY_LOCKED:
    'Inventory tracking cannot be turned off because this item has batch records or is used in a production order.',
  ITEM_UNIT_LOCKED: 'The main unit cannot be changed after the item is created. Add other units as unit conversions instead.',
  NO_ROLE_SELECTED: 'Select at least one of Sellable, Purchasable or Track Inventory',
  SELLING_PRICE_REQUIRED: 'Selling Price is required and must be greater than 0 when Sellable is on',
  COST_PRICE_REQUIRED: 'Cost Price is required and must be greater than 0 when Purchasable is on',
  SALES_ACCOUNT_REQUIRED: 'Sales Account is required when Sellable is on',
  PURCHASE_ACCOUNT_REQUIRED: 'Purchase Account is required when Purchasable is on',
  SELLING_PRICE_NOT_ALLOWED: 'Selling Price should not be set when Sellable is off',
  SALES_ACCOUNT_NOT_ALLOWED: 'Sales Account should not be set when Sellable is off',
  COST_PRICE_NOT_ALLOWED: 'Cost Price should not be set when Purchasable is off',
  PURCHASE_ACCOUNT_NOT_ALLOWED: 'Purchase Account should not be set when Purchasable is off',
  INVENTORY_ACCOUNT_REQUIRED: 'Inventory Account is required when inventory is tracked',
  INVENTORY_ACCOUNT_NOT_ALLOWED: 'Inventory Account should not be set when Track Inventory is off',
  SERVICE_CANNOT_TRACK_INVENTORY: 'A service item cannot track inventory',
  PRODUCTION_ITEM_MUST_BE_STOCK: 'These BOM components are not inventory-tracked and cannot be used in production.',
  OPENING_STOCK_NEEDS_TRACKING: 'Enable "Track Inventory" to enter an opening stock for this item.',
  OPENING_STOCK_ALREADY_USED:
    'Opening stock for this warehouse cannot be updated because stock from the opening balance batch has already been used in a transaction.',
  UPDATE_ITEM_INVENTORY_SUCCESS: 'Item inventory updated successfully',
  UPDATE_ITEM_INVENTORY_FAILURE: 'Failed to update item inventory',
  BULK_ITEM_INVENTORY_VERIFY_SUCCESS: 'Item inventory verified successfully',
  BULK_ITEM_INVENTORY_VERIFY_FAILURE: 'Failed to verify item inventory',
};

const ITEM_GROUP_MESSAGES = {
  CREATE_SUCCESS: 'Item Group Created Successfully',
  CREATE_FAILURE: 'Failed to create Item Group',

  FETCH_ALL_SUCCESS: 'Item Groups fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch Item Groups',

  FETCH_ONE_SUCCESS: 'Item Group fetched Successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch Item Group',
  FETCH_ONE_NOT_FOUND: 'Item Group not found',

  UPDATE_SUCCESS: 'Item Group updated successfully',
  UPDATE_FAILURE: 'Failed to update Item Group',

  DELETE_SUCCESS: 'Item Group deleted successfully',
  DELETE_FAILURE: 'Failed to delete Item Group',
};

const SUB_ITEM_GROUP_MESSAGES = {
  CREATE_SUCCESS: 'Sub Item Group Created Successfully',
  CREATE_FAILURE: 'Failed to create Sub Item Group',

  FETCH_ALL_SUCCESS: 'Sub Item Groups fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch Sub Item Groups',

  FETCH_ONE_SUCCESS: 'Sub Item Group fetched Successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch Sub Item Group',
  FETCH_ONE_NOT_FOUND: 'Sub Item Group not found',

  UPDATE_SUCCESS: 'Sub Item Group updated successfully',
  UPDATE_FAILURE: 'Failed to update Sub Item Group',

  DELETE_SUCCESS: 'Sub Item Group deleted successfully',
  DELETE_FAILURE: 'Failed to delete Sub Item Group',
};

const MODULE_MESSAGES = {
  GET_TREE_SUCCESS: 'Module tree fetched successfully',
  GET_TREE_FAILURE: 'Failed to fetch module tree',

  GET_PERMISSION_MODULES_SUCCESS: 'Permission modules fetched successfully',
  GET_PERMISSION_MODULES_FAILURE: 'Failed to fetch permission modules',

  GET_SETTINGS_FEATURE_PLAN_SUCCESS: 'Settings feature plan status fetched successfully',
  GET_SETTINGS_FEATURE_PLAN_FAILURE: 'Failed to fetch settings feature plan status',

  CREATE_SUCCESS: 'Module created successfully',
  CREATE_FAILURE: 'Failed to create module',

  FETCH_ALL_SUCCESS: 'Modules fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch modules',

  FETCH_ONE_SUCCESS: 'Module fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch module',
  FETCH_ONE_NOT_FOUND: 'Module not found',

  UPDATE_SUCCESS: 'Module updated successfully',
  UPDATE_FAILURE: 'Failed to update module',

  DELETE_SUCCESS: 'Module deleted successfully',
  DELETE_FAILURE: 'Failed to delete module',
};

const MODULE_SETTINGS_MESSAGES = {
  CREATE_SUCCESS: 'Module settings created successfully',
  CREATE_FAILURE: 'Error creating module settings',
  FETCH_ALL_SUCCESS: 'Module settings retrieved successfully',
  FETCH_ALL_FAILURE: 'Error retrieving module settings',
  FETCH_ONE_SUCCESS: 'Module settings retrieved successfully',
  FETCH_ONE_FAILURE: 'Error retrieving module settings',
  UPDATE_SUCCESS: 'Module settings updated successfully',
  UPDATE_FAILURE: 'Error updating module settings',
  DELETE_SUCCESS: 'Module settings deleted successfully',
  DELETE_FAILURE: 'Error deleting module settings',
};

const OPENING_BALANCE_TRANSACTION_MESSAGES = {
  FETCH_HISTORY_SUCCESS: 'Opening balance transaction history fetched successfully',
  FETCH_HISTORY_FAILURE: 'Failed to fetch opening balance transaction history',
};

const PAYMENT_MESSAGES = {
  CREATE_SUCCESS: 'Payment Created Successfully',
  CREATE_FAILURE: 'Failed to create payment',

  FETCH_ALL_SUCCESS: 'Payments processed successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch payments',

  FETCH_ONE_SUCCESS: 'Payment fetched Successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch payment',
  FETCH_ONE_NOT_FOUND: 'Payment not found',

  UPDATE_SUCCESS: 'Payment updated successfully',
  UPDATE_FAILURE: 'Failed to update payment',

  DELETE_SUCCESS: 'Payment deleted successfully',
  DELETE_FAILURE: 'Failed to delete payment',

  APPLY_SUCCESS: 'Payment applied successfully',
  APPLY_FAILURE: 'Failed to apply payment',

  REMOVE_SUCCESS: 'Invoice removed successfully',
  REMOVE_FAILURE: 'Failed to remove Invoice',

  AUTO_APPLY_NO_INVOICES: 'No pending invoices are available to apply your advance payments against.',
  AUTO_APPLY_ADVANCE_WITHOUT_INVOICE:
    'Advance Payment Available: This customer has an advance payment available, but no invoice has been created yet. Auto Pay cannot be processed until an invoice is created.',
  AUTO_APPLY_INVOICE_WITHOUT_ADVANCE:
    'Advance Payment Not Available: This customer has an invoice, but no advance payment is available. Auto Pay cannot be processed until an advance payment is received.',
  AUTO_APPLY_NO_INVOICE_OR_ADVANCE:
    'No Invoice or Advance Payment: This customer has no invoice and no advance payment available. Auto Pay cannot be processed.',
  AUTO_APPLY_COMPLETED: 'Auto payment mapping completed successfully.',
  AUTO_APPLY_FAILURE: 'Auto payment mapping failed',
  AUTO_APPLY_PARTIAL_SUCCESS: 'Auto payment mapping completed successfully with some failures.',
  APPROVE_SUCCESS: 'Payment approved successfully',
  APPROVE_FAILURE: 'Approval failed',
  REJECT_SUCCESS: 'Payment rejected successfully',
  REJECT_FAILURE: 'Rejection failed',
  CANCEL_SUCCESS: 'Payment cancelled successfully',
  CANCEL_FAILURE: 'Cancellation failed',

  ADD_REFUND: 'Refund added successfully',
  DELETE_REFUND: 'Refund deleted successfully',
  UPDATE_REFUND: 'Refund updated successfully',
  ADD_REFUND_FAILED: 'Failed to add refund',
  DELETE_REFUND_FAILED: 'Failed to delete refund',
  UPDATE_REFUND_FAILED: 'Failed to update refund',
};

const PAYMENT_MADE_MESSAGES = {
  CREATE_SUCCESS: 'Purchase Payment Created Successfully',
  CREATE_FAILURE: 'Failed to create purchase payment',

  FETCH_ALL_SUCCESS: 'Purchase Payments fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch purchase payments',

  FETCH_ONE_SUCCESS: 'Purchase Payment fetched Successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch purchase payment',
  FETCH_ONE_NOT_FOUND: 'Purchase Payment not found',

  UPDATE_SUCCESS: 'Purchase Payment updated successfully',
  UPDATE_FAILURE: 'Failed to update purchase payment',

  DELETE_SUCCESS: 'Purchase Payment deleted successfully',
  DELETE_FAILURE: 'Failed to delete purchase payment',

  APPLY_SUCCESS: 'Payment applied successfully',
  APPLY_FAILURE: 'Failed to apply payment',

  REMOVE_SUCCESS: 'Bill removed successfully',
  REMOVE_FAILURE: 'Failed to remove Bill',

  AUTO_APPLY_NO_BILLS: 'No pending bills are available to apply your advance payments against.',
  AUTO_APPLY_ADVANCE_WITHOUT_BILL:
    'Advance Payment Available: This vendor has an advance payment available, but no bill has been created yet. Auto Pay cannot be processed until a bill is created.',
  AUTO_APPLY_BILL_WITHOUT_ADVANCE:
    'Advance Payment Not Available: This vendor has a bill, but no advance payment is available. Auto Pay cannot be processed until an advance payment is received.',
  AUTO_APPLY_NO_BILL_OR_ADVANCE:
    'No Bill or Advance Payment: This vendor has no bill and no advance payment available. Auto Pay cannot be processed.',
  AUTO_APPLY_COMPLETED: 'Auto payment mapping completed successfully.',
  AUTO_APPLY_FAILURE: 'Auto payment mapping failed',
  AUTO_APPLY_PARTIAL_SUCCESS: 'Auto payment mapping completed successfully with some failures.',
  APPROVE_SUCCESS: 'Payment approved successfully',
  APPROVE_FAILURE: 'Approval failed',
  REJECT_SUCCESS: 'Payment rejected successfully',
  REJECT_FAILURE: 'Rejection failed',
  CANCEL_SUCCESS: 'Payment cancelled successfully',
  CANCEL_FAILURE: 'Cancellation failed',
  DELETE_BILL_SUCCESS: 'PaymentMade bill deleted successfully',
  DELETE_BILL_FAILURE: 'Failed to delete PaymentMade bill',
};

const PRICE_LIST_MESSAGES = {
  CREATE_SUCCESS: 'Price List Created Successfully',
  CREATE_FAILURE: 'Failed to create price list',

  FETCH_ALL_SUCCESS: 'Price Lists fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch price lists',

  FETCH_ONE_SUCCESS: 'Price List fetched Successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch price list',
  FETCH_ONE_NOT_FOUND: 'Price List not found',

  UPDATE_SUCCESS: 'Price List updated successfully',
  UPDATE_FAILURE: 'Failed to update price list',

  DELETE_SUCCESS: 'Price List deleted successfully',
  DELETE_FAILURE: 'Failed to delete price list',
  DELETE_IN_USE:
    'Cannot delete: Price List is used in one or more customers, quotes, sales orders, delivery challans, invoices, or recurring invoices',
};

const PROCESS_MESSAGES = {
  CREATE_SUCCESS: 'Process Created Successfully',
  CREATE_FAILURE: 'Failed to create process',

  FETCH_ALL_SUCCESS: 'Processes fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch processes',

  FETCH_ONE_SUCCESS: 'Process fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch process',
  FETCH_ONE_NOT_FOUND: 'Process not found',

  UPDATE_SUCCESS: 'Process updated successfully',
  UPDATE_FAILURE: 'Failed to update process',

  DELETE_SUCCESS: 'Process deleted successfully',
  DELETE_FAILURE: 'Failed to delete process',
  DELETE_IN_USE: 'Cannot delete: Process is used in one or more recipes',
};

const PRODUCTION_ORDER_MESSAGES = {
  CREATE_SUCCESS: 'Production Order created successfully',
  CREATE_FAILURE: 'Failed to create Production Order',
  FETCH_ALL_SUCCESS: 'Production Orders fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch production orders',
  FETCH_ONE_SUCCESS: 'Production Order fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch production orders',
  FETCH_ONE_NOT_FOUND: 'Production Order not found',
  SUBMIT_SUCCESS: 'Production Order updated successfully',
  SUBMIT_FAILURE: 'Failed to update Production Order',
  START_PROCESS_SUCCESS: 'Process started successfully',
  START_PROCESS_FAILURE: 'Failed to start process',
  END_PROCESS_SUCCESS: 'Process ended successfully',
  END_PROCESS_FAILURE: 'Failed to end process',
  SUBMIT_PROCESS_SUCCESS: 'Process submitted successfully',
  SUBMIT_PROCESS_FAILURE: 'Failed to submit process',
  UPDATE_STATUS_SUCCESS: 'Production order status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update production order status',
  RE_RAISE_TRANSFER_SUCCESS: 'Inventory transfer request re-raised successfully',
  RE_RAISE_TRANSFER_FAILURE: 'Failed to re-raise inventory transfer request',
  DELETE_SUCCESS: 'Production Order deleted successfully',
  DELETE_FAILURE: 'Failed to delete Production Order',
  DELETE_NOT_ALLOWED:
    'Production Order cannot be deleted once it has been actioned upon or its inventory transfer request is no longer pending',
  REORDER_PROCESSES_SUCCESS: 'Process sequence updated successfully',
  REORDER_PROCESSES_FAILURE: 'Failed to update process sequence',
  EDIT_SUBMISSION_SUCCESS: 'Submission updated successfully',
  EDIT_SUBMISSION_FAILURE: 'Failed to update submission',
  DELETE_SUBMISSION_SUCCESS: 'Submission deleted successfully',
  DELETE_SUBMISSION_FAILURE: 'Failed to delete submission',
  DELETE_PROCESS_SUBMISSION_SUCCESS: 'Process submission deleted successfully',
  DELETE_PROCESS_SUBMISSION_FAILURE: 'Failed to delete process submission',
  EDIT_PROCESS_SUBMISSION_SUCCESS: 'Process submission updated successfully',
  EDIT_PROCESS_SUBMISSION_FAILURE: 'Failed to update process submission',
  FINISHED_GOOD_MUST_BE_STOCK: 'To produce these items, please enable inventory tracking for them',
  RAW_MATERIAL_MUST_BE_STOCK: 'These raw materials are not inventory-tracked and cannot be used in production',
  SUBMISSION_SCRAP_IN_USE:
    'This submission cannot be deleted because the scrap generated from it has already been used in another transaction. Please remove or reverse that usage first.',
  SUBMISSION_FINISHED_GOODS_IN_USE:
    'This submission cannot be deleted because the finished goods produced from it have already been used in another transaction. Please remove or reverse that usage first.',
  FETCH_PRODUCTION_DATA_SUCCESS: 'Production data fetched successfully',
  FETCH_PRODUCTION_DATA_FAILURE: 'Failed to fetch production data',
  ITEM_NOT_FOUND: 'Item not found',
};

const PROJECT_MESSAGES = {
  CREATE_SUCCESS: 'Project created successfully',
  CREATE_FAILURE: 'An error occurred while creating the Project',

  FETCH_ALL_SUCCESS: 'Projects retrieved successfully',
  FETCH_ALL_FAILURE: 'An error occurred while retrieving projects',
  FETCH_ALL_NOT_FOUND: 'No projects found for the provided companyId',

  UPDATE_SUCCESS: 'Project updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the project',

  FETCH_PROJECT_WITH_TASKS_AND_USERS_SUCCESS: 'Projects retrieved successfully',
  FETCH_PROJECT_WITH_TASKS_AND_USERS_FAILURE: 'An error occurred while retrieving projects',
  FETCH_PROJECT_WITH_TASKS_AND_USERS_NOT_FOUND: 'No projects found for the provided companyId',

  FETCH_PROJECT_NAMES_SUCCESS: 'Project names retrieved successfully',
  FETCH_PROJECT_NAMES_FAILURE: 'An error occurred while fetching project names',
};

const PURCHASE_ORDER_MESSAGES = {
  CREATE_SUCCESS: 'Order Created Successfully',
  CREATE_FAILURE: 'An error occurred while Adding Purchase',

  FETCH_ALL_SUCCESS: 'Purchase Orders retrieved successfully',
  FETCH_ALL_FAILURE: 'An error occurred while retrieving Purchase Orders',
  FETCH_ALL_NOT_FOUND: 'No Purchase Order found for the provided filters',

  UPDATE_SUCCESS: 'Purchase Order updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the Purchase Order',
  UPDATE_NOT_FOUND: 'Purchase Order not found or update failed',

  DELETE_SUCCESS: 'Purchase Order deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the Purchase Order',
  DELETE_NOT_FOUND: 'Purchase Order not found or deletion failed',

  UPDATE_STATUS_SUCCESS: 'Purchase Order status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update purchase order status',

  FETCH_ONE_NOT_FOUND: 'Purchase Order not found',
  FETCH_ONE_SUCCESS: 'Purchase Order retrieved successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch Purchase Order',
};

const GRPO_ORDER_MESSAGES = {
  CREATE_SUCCESS: 'Grpo Order Created Successfully',
  CREATE_FAILURE: 'An error occurred while Adding Grpo',
  FETCH_NOT_FOUND: 'Grpo Order not found',
  FETCH_ALL_SUCCESS: 'Grpo Orders retrieved successfully',
  FETCH_ALL_FAILURE: 'An error occurred while retrieving Grpo Orders',
  FETCH_ALL_NOT_FOUND: 'No Grpo Order found for the provided filters',

  UPDATE_SUCCESS: 'Grpo Order updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the Grpo Order',
  UPDATE_NOT_FOUND: 'Grpo Order not found or update failed',

  DELETE_SUCCESS: 'Grpo Order deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the Grpo Order',
  DELETE_NOT_FOUND: 'Grpo Order not found or deletion failed',

  UPDATE_STATUS_NOT_FOUND: 'Grpo Order not found',
  UPDATE_STATUS_SUCCESS: 'Grpo Order status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update grpo order status',

  FETCH_ONE_NOT_FOUND: 'Grpo Order not found',
  FETCH_ONE_SUCCESS: 'Grpo Order fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch Grpo Order',
};

const QC_MASTER_MESSAGES = {
  CREATE_SUCCESS: 'QC Master created successfully',
  CREATE_FAILURE: 'An error occurred while creating QC Master',

  FETCH_ALL_SUCCESS: 'QC Masters retrieved successfully',
  FETCH_ALL_FAILURE: 'An error occurred while retrieving QC Masters',
  FETCH_ALL_NOT_FOUND: 'No QC Masters found for the provided companyId',

  UPDATE_SUCCESS: 'QC Master updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the QC Master',
  UPDATE_NOT_FOUND: 'QC Master not found or update failed',

  DELETE_SUCCESS: 'QC Master deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the QC Master',
  DELETE_NOT_FOUND: 'QC Master not found or deletion failed',
  DELETE_IN_USE: 'Cannot delete: QC Master is used in one or more items',

  FETCH_DROPDOWN_SUCCESS: 'QC retrieved successfully',
  FETCH_DROPDOWN_FAILURE: 'An error occurred while fetching QC dropdown',
  FETCH_ONE_NOT_FOUND: 'QC Master not found',
  FETCH_ONE_SUCCESS: 'QC Master retrieved successfully',
  FETCH_ONE_FAILURE: 'An error occurred while retrieving QC Master',
};

const QUOTE_MESSAGES = {
  CREATE_SUCCESS: 'Quote Created Successfully',
  CREATE_FAILURE: 'An error occurred while creating the quote',

  FETCH_ALL_SUCCESS: 'Quotes processed successfully',
  FETCH_ALL_FAILURE: 'An error occurred while retrieving quotes',
  FETCH_NOT_FOUND: 'Quote not found',
  FETCH_ONE_SUCCESS: 'Quote fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch quote',

  UPDATE_SUCCESS: 'Quote updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the quote',

  DELETE_SUCCESS: 'Quote deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the quote',

  SEND_SUCCESS: 'Quote sent successfully',
  SEND_FAILURE: 'Failed to send quote',

  UPDATE_STATUS_SUCCESS: 'Quote status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update quote status',
};

const CUSTOMER_ORDER_MESSAGES = {
  FETCH_ALL_SUCCESS: 'Customer Orders processed successfully',
  FETCH_ALL_FAILURE: 'An error occurred while retrieving customer orders',
  FETCH_NOT_FOUND: 'Customer Order not found',
  FETCH_ONE_SUCCESS: 'Customer Order fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch customer order',
  UPDATE_STATUS_SUCCESS: 'Customer Order status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update customer order status',
  CONVERSION_NOT_ALLOWED: 'Only an accepted customer order can be converted to a sales order',
  CUSTOMER_MISMATCH: 'The sales order customer must match the customer order customer',
  INVALID_STATUS_CHANGE: (fromStatus, toStatus) => `A customer order cannot move from ${fromStatus} to ${toStatus}`,
  SAMPLE_QTY_OUT_OF_RANGE: (itemName, minQty, maxQty, unitName) =>
    `Quantity for ${itemName} must be between ${minQty} and ${maxQty} ${unitName}, as set in the sample catalog`,
};

const SAMPLE_CATALOG_MESSAGES = {
  CREATE_SUCCESS: 'Sample Catalog created successfully',
  CREATE_FAILURE: 'Failed to create sample catalog',
  UPDATE_SUCCESS: 'Sample Catalog updated successfully',
  UPDATE_FAILURE: 'Failed to update sample catalog',
  UPDATE_STATUS_SUCCESS: 'Sample Catalog status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update sample catalog status',
  FETCH_ALL_SUCCESS: 'Sample Catalogs fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch sample catalogs',
  FETCH_ONE_SUCCESS: 'Sample Catalog fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch sample catalog',
  NOT_FOUND: 'Sample Catalog not found',
  ITEM_NOT_FOUND: 'One or more items were not found or are inactive',
  UNIT_NOT_ALLOWED: 'Unit is not configured for item',
  CUSTOMER_NOT_FOUND: 'One or more selected customers were not found or are inactive',
  ACTIVATE_NEEDS_ITEM: 'Add at least one item before activating the sample catalog',
  ACTIVATE_EXPIRED: 'Cannot activate a sample catalog whose end date has passed',
  STATUS_UNCHANGED: 'Sample Catalog is already in this status',
  ITEMS_NOT_ON_PORTAL: itemNames =>
    `These items are not available in the customer portal for this catalog's customers: ${itemNames.join(', ')}. Confirm activation to save.`,
};

const RECIPE_MESSAGES = {
  CREATE_SUCCESS: 'Recipe Created Successfully',
  CREATE_FAILURE: 'An error occurred while creating the recipe',

  FETCH_ALL_SUCCESS: 'Recipes processed successfully',
  FETCH_ALL_FAILURE: 'An error occurred while fetching recipes',
  FETCH_NOT_FOUND: 'Recipe not found',

  FETCH_ONE_SUCCESS: 'Recipe fetched Successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch recipe',

  UPDATE_SUCCESS: 'Recipe updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the recipe',

  DELETE_SUCCESS: 'Recipe deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the recipe',
  DELETE_IN_USE: 'Cannot delete: Recipe is used in one or more items or production orders',

  DROPDOWN_SUCCESS: 'Recipes retrieved successfully',
  DROPDOWN_FAILURE: 'An error occurred while fetching recipes dropdown',
};

const RECURRING_BILL_MESSAGES = {
  CREATE_SUCCESS: 'Recurring Bill Created Successfully',
  CREATE_FAILURE: 'Failed to Create Recurring Bill',

  FETCH_ALL_SUCCESS: 'Recurring bills retrieved successfully',
  FETCH_ALL_FAILURE: 'Failed to retrieve recurring bills',
  FETCH_NOT_FOUND: 'Recurring bill not found',
  FETCH_ONE_SUCCESS: 'Recurring bill retrieved successfully',

  UPDATE_SUCCESS: 'Recurring bill updated successfully',
  UPDATE_FAILURE: 'Failed to update recurring bill',
  UPDATE_DRAFT_ONLY: 'Only recurring bills in Draft status can be edited',

  DELETE_SUCCESS: 'Recurring bill deleted successfully',
  DELETE_FAILURE: 'Failed to delete recurring bill',
  DELETE_DRAFT_ONLY: 'Only recurring bills in Draft status can be deleted',

  CREATE_BILL_SUCCESS: 'Bill created from recurring bill successfully',
  CREATE_BILL_FAILURE: 'Failed to create bill from recurring bill',

  STATUS_UPDATE_SUCCESS: 'Recurring bill status updated successfully',
  STATUS_UPDATE_FAILURE: 'Failed to update recurring bill status',
};

const RECURRING_EXPENSE_MESSAGES = {
  CREATE_SUCCESS: 'Recurring Expense Created Successfully',
  CREATE_FAILURE: 'Failed to Create Recurring Expense',

  FETCH_ALL_SUCCESS: 'Recurring expenses retrieved successfully',
  FETCH_ALL_FAILURE: 'Failed to retrieve recurring expenses',
  FETCH_NOT_FOUND: 'Recurring expense not found',
  FETCH_ONE_SUCCESS: 'Recurring expense retrieved successfully',

  UPDATE_SUCCESS: 'Recurring expense updated successfully',
  UPDATE_FAILURE: 'Failed to update recurring expense',

  DELETE_SUCCESS: 'Recurring expense deleted successfully',
  DELETE_FAILURE: 'Failed to delete recurring expense',

  CREATE_EXPENSE_SUCCESS: 'Expense created from recurring expense successfully',
  CREATE_EXPENSE_FAILURE: 'Failed to create expense from recurring expense',

  STATUS_UPDATE_SUCCESS: 'Recurring expense status updated successfully',
  STATUS_UPDATE_FAILURE: 'Failed to update recurring expense status',
};

const RECURRING_INVOICE_MESSAGES = {
  CREATE_SUCCESS: 'Recurring Invoice Created Successfully',
  CREATE_FAILURE: 'An error occurred while creating recurring invoice',

  FETCH_ALL_SUCCESS: 'Recurring Invoices processed successfully',
  FETCH_ALL_FAILURE: 'An error occurred while fetching recurring invoices',
  FETCH_NOT_FOUND: 'Recurring Invoice not found',
  FETCH_ONE_SUCCESS: 'Recurring Invoice retrieved successfully',

  UPDATE_SUCCESS: 'Recurring Invoice updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the recurring invoice',
  UPDATE_DRAFT_ONLY: 'Only recurring invoices in Draft status can be edited',

  DELETE_SUCCESS: 'Recurring Invoice deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the recurring invoice',
  DELETE_DRAFT_ONLY: 'Only recurring invoices in Draft status can be deleted',

  CREATE_INVOICE_SUCCESS: 'Invoice created from recurring invoice successfully',
  CREATE_INVOICE_FAILURE: 'Failed to create invoice from recurring invoice',

  STATUS_UPDATE_SUCCESS: 'Recurring invoice status updated successfully',
  STATUS_UPDATE_FAILURE: 'Failed to update recurring invoice status',
};

const REPORT_MESSAGES = {
  BALANCE_SHEET_FETCH_SUCCESS: 'Balance sheet with ledger transactions fetched successfully',
  BALANCE_SHEET_FETCH_FAILURE: 'Failed to fetch balance sheet',
  PROFIT_LOSS_SHEET_FETCH_SUCCESS: 'Profit & Loss sheet fetched successfully',
  PROFIT_LOSS_SHEET_FETCH_FAILURE: 'Failed to fetch Profit & Loss sheet',
};

const ROLE_MESSAGES = {
  CREATE_SUCCESS: 'Role Created Successfully',
  CREATE_FAILURE: 'An error occurred while creating the role',

  FETCH_ALL_SUCCESS: 'Roles fetched successfully',
  FETCH_ALL_FAILURE: 'An error occurred while fetching roles',
  FETCH_NOT_FOUND: 'Role not found',
  FETCH_ONE_SUCCESS: 'Role fetched successfully',

  UPDATE_SUCCESS: 'Role updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the role',

  DELETE_SUCCESS: 'Role deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the role',
};

const SALES_ORDER_MESSAGES = {
  MULTIPLE_SOURCES: 'A sales order can be created from only one source document',
  CREATE_SUCCESS: 'Sales Order Created Successfully',
  CREATE_FAILURE: 'An error occurred while creating the sales order',
  SALES_ORDER_NOT_FOUND: 'Sales Order not found',
  FETCH_ALL_SUCCESS: 'Sales Orders processed successfully',
  FETCH_ALL_FAILURE: 'An error occurred while fetching sales orders',
  FETCH_NOT_FOUND: 'Sales Order not found',
  FETCH_ONE_SUCCESS: 'Sales Order fetched successfully',

  UPDATE_SUCCESS: 'Sales Order updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the sales order',

  UPDATE_STATUS_SUCCESS: 'Sales Order status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update sales order status',

  REVERT_CLOSE_SUCCESS: 'Sales Order close reverted successfully',
  REVERT_CLOSE_FAILURE: 'Failed to revert the sales order close',
  REVERT_CLOSE_NOT_CLOSED: 'Only a closed sales order can be reverted',

  DELETE_SUCCESS: 'Sales Order deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the sales order',
  DELETE_RESTRICTED_REJECTION_ORDER:
    'This sales order cannot be deleted because its linked rejection order has been sorted or devolved',

  ITEM_NOT_FOUND: 'Item for this SalesOrders not found',

  COMPANY_ID_REQUIRED: 'Company ID is required',
  CUSTOMER_ID_REQUIRED: 'Customer ID is required',
  SALES_ORDER_IDS_REQUIRED: 'Sales order id(s) are required',
  INVALID_SALES_ORDER_ID: 'Invalid sales order id',
  PARTIALLY_CONVERTED_ORDERS_NOT_FOUND: 'One or more sales orders not found',
  INVALID_COMPANY_OR_CUSTOMER_ID: 'Invalid company or customer id',
  INVALID_COMPANY_ID: 'Invalid company id',
};

const TAX_MESSAGES = {
  RETRIEVE_SUCCESS: 'Taxes retrieved successfully',
  RETRIEVE_FAILURE: 'An error occurred while retrieving taxes',

  SINGLE_RETRIEVE_SUCCESS: 'Tax retrieved successfully',
  SINGLE_RETRIEVE_FAILURE: 'An error occurred while retrieving the tax',

  CREATE_SUCCESS: 'Tax created successfully',
  CREATE_FAILURE: 'An error occurred while creating the tax',

  UPDATE_SUCCESS: 'Tax updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the tax',

  DELETE_SUCCESS: 'Tax deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the tax',

  STATUS_UPDATE_SUCCESS: 'Tax status updated successfully',
  STATUS_UPDATE_FAILURE: 'An error occurred while updating the tax status',

  SECTIONS_RETRIEVE_SUCCESS: 'Tax sections retrieved successfully',
  SECTIONS_RETRIEVE_FAILURE: 'An error occurred while retrieving tax sections',
  DROPDOWN_RETRIEVE_SUCCESS: 'Taxes retrieved successfully',
  DROPDOWN_RETRIEVE_FAILURE: 'An error occurred while retrieving taxes',

  NOT_FOUND: 'Tax not found',
  DUPLICATE_NAME: 'A tax with this name already exists',
  INVALID_SECTION: 'Select a valid section for this tax type',
  END_BEFORE_START: 'End Date must be on or after the Start Date',

  SEED_SUCCESS: 'Default taxes added successfully',
  SEED_ALREADY_EXISTS: 'All default taxes already exist',
  SEED_FAILURE: 'An error occurred while seeding default taxes',
};

const TIMESHEET_MESSAGES = {
  CREATE_SUCCESS: 'Timesheet created successfully',
  CREATE_FAILURE: 'An error occurred while creating the timesheet',

  RETRIEVE_SUCCESS: 'Timesheets retrieved successfully',
  RETRIEVE_FAILURE: 'An error occurred while retrieving timesheets',

  UPDATE_SUCCESS: 'Timesheet updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the timesheet',
};

const TRANSPORT_COURIER_MESSAGES = {
  CREATE_SUCCESS: 'TransportCourier Created Successfully',
  CREATE_FAILURE: 'Failed to create transport courier',

  FETCH_ALL_SUCCESS: 'Transport fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to get transport couriers',

  FETCH_ONE_SUCCESS: 'Transport fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to get transport courier',
  FETCH_ONE_NOT_FOUND: 'Transport Courier not found',

  UPDATE_SUCCESS: 'Transport Updated successfully',
  UPDATE_FAILURE: 'Failed to update transport courier',

  DELETE_SUCCESS: 'Transport deleted successfully',
  DELETE_FAILURE: 'Failed to delete transport courier',
};

const USER_MESSAGES = {
  CREATE_SUCCESS: 'User created successfully',
  CREATE_FAILURE: 'An error occurred while creating the user',

  RETRIEVE_SUCCESS: 'Users retrieved successfully',
  RETRIEVE_ONE_SUCCESS: 'User retrieved successfully',
  RETRIEVE_FAILURE: 'An error occurred while retrieving users',
  NOT_FOUND: 'User not found',

  UPDATE_SUCCESS: 'User updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the user',

  DELETE_SUCCESS: 'User deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the user',

  INVITE_SUCCESS: 'Invitation sent successfully',
  INVITE_FAILURE: 'An error occurred while sending the invitation',

  VERIFY_SUCCESS: 'Invite token verified successfully',
  VERIFY_FAILURE: 'An error occurred while verifying the invite',

  STATUS_UPDATE_SUCCESS: 'User status updated successfully',
  STATUS_UPDATE_FAILURE: 'An error occurred while updating user status',

  COMPANY_NOT_FOUND: 'Company not found',
  SET_DEFAULT_CONFIGURATION: 'Default configuration saved successfully',
  FAILE_DEFAULT_CONFIGURATION: 'Failed to set Default configuration',
  HAS_CREATED_RECORDS: 'This user has created records in this company and cannot be deleted. Deactivate the user instead.',
};

const DEBIT_NOTE_MESSAGES = {
  CREATE_SUCCESS: 'Debit Note created successfully',
  CREATE_FAILURE: 'An error occurred while creating debit note',

  RETRIEVE_SUCCESS: 'Debit Notes fetched successfully',
  RETRIEVE_ONE_SUCCESS: 'Debit Note fetched successfully',
  RETRIEVE_FAILURE: 'An error occurred while fetching debit notes',
  NOT_FOUND: 'Debit Note not found',

  UPDATE_SUCCESS: 'Debit Note updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating debit note',

  DELETE_SUCCESS: 'Debit Note deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting debit note',

  APPLY_SUCCESS: 'Debit Note applied successfully',
  APPLY_FAILURE: 'An error occurred while applying debit note',

  REFUND_SUCCESS: 'Refund processed successfully',
  REFUND_FAILURE: 'Failed to process refund',
  REFUND_DELETE_SUCCESS: 'Refund deleted successfully',
  REFUND_DELETE_FAILURE: 'Failed to delete refund',
  HAS_REFUNDS: 'Cannot cancel this debit note because it has existing refunds. Please delete all refunds first.',
  REFUND_INVALID_STATUS: 'Refunds can only be added to open or partially used debit notes.',
};

const WAREHOUSE_MESSAGES = {
  CREATE_SUCCESS: 'Warehouse created successfully',
  CREATE_FAILURE: 'An error occurred while creating the warehouse',

  RETRIEVE_ALL_SUCCESS: 'Warehouses retrieved successfully',
  RETRIEVE_ONE_SUCCESS: 'Warehouse retrieved successfully',
  RETRIEVE_FAILURE: 'An error occurred while retrieving warehouses',

  UPDATE_SUCCESS: 'Warehouse updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the warehouse',

  DELETE_SUCCESS: 'Warehouse deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting the warehouse',
  DELETE_IN_USE: 'Cannot delete this warehouse because it is referenced in one or more existing documents.',

  DROPDOWN_SUCCESS: 'Warehouses dropdown retrieved successfully',
  DROPDOWN_FAILURE: 'An error occurred while retrieving warehouse dropdown data',
  FETCH_ONE_NOT_FOUND: 'Warehouse not found',

  UPDATE_STATUS_SUCCESS: 'Warehouse status updated successfully',
  UPDATE_STATUS_FAILURE: 'An error occurred while updating warehouse status',
};

const CRON_LOGS_MESSAGES = {
  RETRIEVE_SUCCESS: 'Cron error logs retrieved successfully',
  RETRIEVE_FAILURE: 'An error occurred while retrieving cron error logs',
};

const AUTH_MESSAGES = {
  REGISTER_SUCCESS: 'User registered successfully',
  REGISTER_FAILURE: "We couldn't complete your registration. Please check your details and try again.",

  LOGIN_SUCCESS: 'Login successful',
  LOGIN_FAILURE: "We couldn't sign you in. Please check your email and password and try again.",

  LOGOUT_SUCCESS: 'Logged out successfully',
  LOGOUT_FAILURE: "We couldn't sign you out. Please try again.",

  TOKEN_REFRESH_SUCCESS: 'Your session has been renewed.',
  TOKEN_REFRESH_FAILURE: "We couldn't renew your session. Please sign in again.",

  RESET_PASSWORD_EMAIL_SENT: 'Reset password email sent successfully',
  RESET_PASSWORD_EMAIL_FAILURE: 'Failed to send reset password email',

  PASSWORD_RESET_SUCCESS: 'Password reset successfully',
  PASSWORD_RESET_FAILURE: 'Password reset failed',

  VERIFICATION_EMAIL_SENT: 'Verification email sent successfully',
  VERIFICATION_EMAIL_FAILURE: 'Failed to send verification email',

  EMAIL_VERIFIED: 'Email verified successfully',
  EMAIL_VERIFICATION_FAILURE: 'Email verification failed',

  COMPANY_CREATED: 'Company created successfully, Sign in to continue',
  COMPANY_CREATION_FAILURE: 'Failed to create company',

  TOKEN_VALID: "You're verified.",
};

const COMPANY_MESSAGES = {
  UPDATE_SUCCESS: 'Company updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating the company',

  FETCH_ONE_SUCCESS: 'Company retrieved successfully',
  FETCH_ONE_FAILURE: 'Failed to retrieve company',
  FETCH_ONE_NOT_FOUND: 'Company not found',

  SENT_PIN_FAILURE: 'Failed to sent Pin Number',
  SENT_PIN_SUCCESS: 'Pin Number sent successfully',

  VERIFY_PIN_FAILURE: 'Failed to verify Pin Number',
  VERIFY_PIN_SUCCESS: 'Pin Number verified successfully',
  INVALID_PIN: 'Please enter a valid PIN.',

  ADDITIONAL_CHARGE_ADD_SUCCESS: 'Additional charge added successfully',
  ADDITIONAL_CHARGE_ADD_FAILURE: 'Failed to add additional charge',
  ADDITIONAL_CHARGE_UPDATE_SUCCESS: 'Additional charge updated successfully',
  ADDITIONAL_CHARGE_UPDATE_FAILURE: 'Failed to update additional charge',
  ADDITIONAL_CHARGE_DELETE_SUCCESS: 'Additional charge deleted successfully',
  ADDITIONAL_CHARGE_DELETE_FAILURE: 'Failed to delete additional charge',

  INVENTORY_CONFIG_UPDATE_SUCCESS: 'Inventory configuration updated successfully',
  INVENTORY_CONFIG_UPDATE_FAILURE: 'Failed to update inventory configuration',
  INVENTORY_CONFIG_FETCH_SUCCESS: 'Inventory configuration fetched successfully',
  INVENTORY_CONFIG_FETCH_FAILURE: 'Failed to fetch inventory configuration',

  AUTO_PAY_CONFIG_UPDATE_SUCCESS: 'Auto Pay configuration updated successfully',
  AUTO_PAY_CONFIG_UPDATE_FAILURE: 'Failed to update Auto Pay configuration',
  AUTO_PAY_CONFIG_FETCH_SUCCESS: 'Auto Pay configuration fetched successfully',
  AUTO_PAY_CONFIG_FETCH_FAILURE: 'Failed to fetch Auto Pay configuration',

  QUOTATION_CONFIG_UPDATE_SUCCESS: 'Quotation configuration updated successfully',
  QUOTATION_CONFIG_UPDATE_FAILURE: 'Failed to update quotation configuration',
  QUOTATION_CONFIG_FETCH_SUCCESS: 'Quotation config retrieved successfully',
  QUOTATION_CONFIG_FETCH_FAILURE: 'Failed to retrieve quotation config',
  QUOTATION_CONFIG_UPDATE_BY_COMPANY_SUCCESS: 'Quotation config updated successfully',
  QUOTATION_CONFIG_UPDATE_BY_COMPANY_FAILURE: 'Failed to update quotation config',

  SETTINGS_FETCH_SUCCESS: 'Company settings retrieved successfully',
  SETTINGS_FETCH_FAILURE: 'Failed to retrieve company settings',

  BRANCH_CONFIG_UPDATE_SUCCESS: 'Branch configuration updated successfully',
  BRANCH_CONFIG_UPDATE_FAILURE: 'Failed to update branch configuration',
  BRANCH_CONFIG_FETCH_SUCCESS: 'Branch configuration retrieved successfully',
  BRANCH_CONFIG_FETCH_FAILURE: 'Failed to retrieve branch configuration',

  REJECTION_WAREHOUSE_CONFIG_UPDATE_SUCCESS: 'Rejection warehouse configuration updated successfully',
  REJECTION_WAREHOUSE_CONFIG_UPDATE_FAILURE: 'Failed to update rejection warehouse configuration',
  REJECTION_WAREHOUSE_CONFIG_FETCH_SUCCESS: 'Rejection warehouse configuration fetched successfully',
  REJECTION_WAREHOUSE_CONFIG_FETCH_FAILURE: 'Failed to fetch rejection warehouse configuration',

  DISCOUNT_CONFIG_UPDATE_SUCCESS: 'Discount setting updated successfully',
  DISCOUNT_CONFIG_UPDATE_FAILURE: 'Failed to update discount setting',

  EMAIL_CONFIG_REQUIRED: 'Configure and enable email in Settings > Email config before turning on Email Send.',
  EMAIL_CONFIG_UPDATE_SUCCESS: 'Email configuration updated successfully',
  EMAIL_CONFIG_UPDATE_FAILURE: 'Failed to update email configuration',
  EMAIL_CONFIG_FETCH_SUCCESS: 'Email configuration fetched successfully',
  EMAIL_CONFIG_FETCH_FAILURE: 'Failed to fetch email configuration',
  MODULE_EMAIL_CONFIG_UPDATE_SUCCESS: 'Module email configuration updated successfully',
  MODULE_EMAIL_CONFIG_UPDATE_FAILURE: 'Failed to update module email configuration',
  MODULE_EMAIL_CONFIG_FETCH_SUCCESS: 'Module email configuration fetched successfully',
  MODULE_EMAIL_CONFIG_FETCH_FAILURE: 'Failed to fetch module email configuration',
  EMAIL_CONFIG_TEST_SUCCESS: 'SMTP connection verified successfully.',
  EMAIL_CONFIG_TEST_FAILURE: 'Failed to verify SMTP connection.',

  ADDITIONAL_ADDRESS_ADD_SUCCESS: 'Additional address added successfully',
  ADDITIONAL_ADDRESS_ADD_FAILURE: 'Failed to add additional address',
  ADDITIONAL_ADDRESS_FETCH_SUCCESS: 'Company shipping addresses retrieved successfully',
  ADDITIONAL_ADDRESS_FETCH_FAILURE: 'Failed to retrieve company shipping addresses',
  ADDITIONAL_ADDRESS_UPDATE_SUCCESS: 'Additional address updated successfully',
  ADDITIONAL_ADDRESS_UPDATE_FAILURE: 'Failed to update additional address',
  ADDITIONAL_ADDRESS_TOGGLE_SUCCESS: 'Additional address toggled successfully',
  ADDITIONAL_ADDRESS_TOGGLE_FAILURE: 'Failed to toggle additional address',

  SUBSCRIPTION_FETCH_SUCCESS: 'Subscription details retrieved successfully',
  SUBSCRIPTION_FETCH_FAILURE: 'Failed to retrieve subscription details',

  CREDIT_LIMIT_CONFIG_UPDATE_SUCCESS: 'Credit limit configuration updated successfully',
  CREDIT_LIMIT_CONFIG_UPDATE_FAILURE: 'Failed to update credit limit configuration',
  CREDIT_LIMIT_CONFIG_FETCH_SUCCESS: 'Credit limit configuration retrieved successfully',
  CREDIT_LIMIT_CONFIG_FETCH_FAILURE: 'Failed to retrieve credit limit configuration',

  ADMIN_SUMMARY_SETTING_FETCH_SUCCESS: 'Admin summary setting retrieved successfully',
  ADMIN_SUMMARY_SETTING_FETCH_FAILURE: 'Failed to retrieve admin summary setting',
  ADMIN_SUMMARY_SETTING_UPDATE_SUCCESS: 'Admin summary setting updated successfully',
  ADMIN_SUMMARY_SETTING_UPDATE_FAILURE: 'Failed to update admin summary setting',

  COMPANY_CODE_FETCH_SUCCESS: 'Company code retrieved successfully',
  COMPANY_CODE_FETCH_FAILURE: 'Failed to retrieve company code',
  COMPANY_CODE_GENERATE_SUCCESS: 'Company code generated successfully',
  COMPANY_CODE_GENERATE_FAILURE: 'Failed to generate company code',
  COMPANY_CODE_ALREADY_EXISTS: 'Company code is already generated and cannot be changed',
};

const STOCK = {
  CREATE_SUCCESS: 'Stock created successfully',
  CREATE_FAILURE: 'Failed to create stock',
  FETCH_ALL_SUCCESS: 'Stocks retrieved successfully',
  FETCH_ALL_FAILURE: 'Failed to retrieve stocks',
  UPDATE_SUCCESS: 'Stock updated successfully',
  UPDATE_FAILURE: 'Failed to update stock',
  FETCH_DROPDOWN_SUCCESS: 'Items for dropdown retrieved successfully',
  FETCH_DROPDOWN_FAILURE: 'Failed to retrieve items for dropdown',
  FETCH_ONE_SUCCESS: 'Item retrieved successfully',
  FETCH_ONE_FAILURE: 'Failed to retrieve item',
  FETCH_ONE_NOT_FOUND: 'Item not found',
  DELETE_SUCCESS: 'Item deleted successfully',
  DELETE_FAILURE: 'Failed to delete item',
};

const DASHBOARD_MESSAGES = {
  FETCH_USER_WISE_SUMMARY_SUCCESS: 'User-wise summary fetched successfully',
  FETCH_USER_WISE_SUMMARY_FAILURE: 'Failed to fetch user-wise summary',
  FETCH_DASHBOARD_SALESORDER: 'Salesorder analytics fetched successfully',
  FETCH_DASHBOARD_PURCHASEORDER: 'Purchaseorder analytics fetched successfully',
  FETCH_SALESORDER_FAILURE: 'Failed to fetch Salesorder analytics',
  FETCH_PURCHASEORDER_FAILURE: 'Failed to fetch Purchaseorder analytics',
  FETCH_DASHBOARD_INVOICE: 'Dashboard analytics fetched successfully',
  FETCH_DASHBOARD_INVOICE_FAILURE: 'Failed to fetch dashboard analytics',
  FETCH_DASHBOARD_BILL: 'Dashboard bill analytics fetched successfully',
  FETCH_DASHBOARD_BILL_FAILURE: 'Failed to fetch dashboard bill analytics',
};

const SALES_DASHBOARD_MESSAGES = {
  FETCH_SUMMARY_SUCCESS: 'Sales dashboard summary fetched successfully',
  FETCH_SUMMARY_FAILURE: 'Failed to fetch sales dashboard summary',
  FETCH_STATE_WISE_SUCCESS: 'State-wise data fetched successfully',
  FETCH_STATE_WISE_FAILURE: 'Failed to fetch state-wise data',
  FETCH_CITY_WISE_SUCCESS: 'City-wise data fetched successfully',
  FETCH_CITY_WISE_FAILURE: 'Failed to fetch city-wise data',
  FETCH_CUSTOMER_WISE_SUCCESS: 'Customer-wise data fetched successfully',
  FETCH_CUSTOMER_WISE_FAILURE: 'Failed to fetch customer-wise data',
  FETCH_ITEM_WISE_SUCCESS: 'Item-wise data fetched successfully',
  FETCH_ITEM_WISE_FAILURE: 'Failed to fetch item-wise data',
  FETCH_STATE_WISE_GRAPH_SUCCESS: 'State wise graph fetched successfully',
  FETCH_STATE_WISE_GRAPH_FAILURE: 'Failed to fetch state wise graph',
  FETCH_ORDER_INVOICE_PAYMENT_TREND_SUCCESS: 'Order invoice payment trend fetched successfully',
  FETCH_ORDER_INVOICE_PAYMENT_TREND_FAILURE: 'Failed to fetch order invoice payment trend',
  FETCH_ORDER_STATUS_SUMMARY_SUCCESS: 'Order status summary fetched successfully',
  FETCH_ORDER_STATUS_SUMMARY_FAILURE: 'Failed to fetch order status summary',
  FETCH_ITEM_WISE_DETAILS_SUCCESS: 'Item wise details fetched successfully',
  FETCH_ITEM_WISE_DETAILS_FAILURE: 'Failed to fetch item wise details',
  FETCH_CUSTOMER_WISE_DETAILS_SUCCESS: 'Customer wise details fetched successfully',
  FETCH_CUSTOMER_WISE_DETAILS_FAILURE: 'Failed to fetch customer wise details',
  FETCH_CUSTOMERS_SUCCESS: 'Customer data fetched successfully',
  FETCH_CUSTOMERS_FAILURE: 'Failed to fetch customer data',
  FETCH_INACTIVE_CUSTOMERS_SUCCESS: 'Inactive customers fetched successfully',
  FETCH_INACTIVE_CUSTOMERS_FAILURE: 'Failed to fetch inactive customers',
  FETCH_NON_ORDER_CUSTOMERS_SUCCESS: 'Non-order customers fetched successfully',
  FETCH_NON_ORDER_CUSTOMERS_FAILURE: 'Failed to fetch non-order customers',
  FETCH_NON_ORDER_CUSTOMER_LIST_SUCCESS: 'Non-order customer list fetched successfully',
  FETCH_NON_ORDER_CUSTOMER_LIST_FAILURE: 'Failed to fetch non-order customer list',
  FETCH_CUSTOMER_INVOICES_SUCCESS: 'Customer invoices fetched successfully',
  FETCH_CUSTOMER_INVOICES_FAILURE: 'Failed to fetch customer invoices',
  FETCH_ITEM_GROUP_ANALYTICS_SUCCESS: 'Item group analytics fetched successfully',
  FETCH_ITEM_GROUP_ANALYTICS_FAILURE: 'Failed to fetch item group analytics',
};

const LOCATION_MESSAGES = {
  COUNTRIES_FETCH_SUCCESS: 'Countries fetched successfully',
  COUNTRIES_FETCH_FAILURE: 'Failed to fetch countries',
  STATES_FETCH_SUCCESS: 'States fetched successfully',
  STATES_FETCH_FAILURE: 'Failed to fetch states',
  CITIES_FETCH_SUCCESS: 'Cities fetched successfully',
  CITIES_FETCH_FAILURE: 'Failed to fetch cities',
};

const LEDGER_MESSAGES = {
  FETCH_SUCCESS: 'Ledger report fetched successfully',
  FETCH_FAILURE: 'Failed to fetch ledger report',
  CREATE_SUCCESS: 'Ledger created successfully',
  CREATE_FAILURE: 'Failed to create ledger',
  FETCH_ALL_SUCCESS: 'Ledger retrieved successfully',
  FETCH_ALL_FAILURE: 'Failed to retrieve ledger',
  UPDATE_SUCCESS: 'Ledger updated successfully',
  UPDATE_FAILURE: 'Failed to update ledger',
  FETCH_ONE_NOT_FOUND: 'Ledger not found',
  DELETE_SUCCESS: 'Ledger deleted successfully',
  DELETE_FAILURE: 'Failed to delete ledger',
};

const MANPOWER_MESSAGES = {
  CREATE_SUCCESS: 'Manpower created successfully',
  FAILED_TO_CREATE: 'Failed to create manpower',

  RETRIEVE_SUCCESS: 'Manpower retrieved successfully',
  RETRIEVE_FAILURE: 'An error occurred while retrieving manpower',
  RETRIEVE_ALL_SUCCESS: 'Manpower retrieved successfully',
  RETRIEVE_ALL_FAILURE: 'An error occurred while retrieving manpower',
  UPDATE_SUCCESS: 'Manpower updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating manpower',
  DELETE_SUCCESS: 'Manpower deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting manpower',
  FETCH_DROPDOWN_SUCCESS: 'Manpower dropdown retrieved successfully',
  FETCH_DROPDOWN_FAILURE: 'Failed to retrieve manpower dropdown',
};

const MACHINE_MESSAGES = {
  CREATE_SUCCESS: 'Machine created successfully',
  FAILED_TO_CREATE: 'Failed to create machine',

  RETRIEVE_SUCCESS: 'Machines retrieved successfully',
  RETRIEVE_FAILURE: 'An error occurred while retrieving machines',
  RETRIEVE_ONE_SUCCESS: 'Machine retrieved successfully',

  UPDATE_SUCCESS: 'Machine updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating machine',

  UPDATE_STATUS_SUCCESS: 'Machine active status updated successfully',
  UPDATE_STATUS_FAILURE: 'An error occurred while updating machine active status',

  DELETE_SUCCESS: 'Machine deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting machine',
  DELETE_IN_USE:
    'Cannot delete: Machine is used in one or more maintenance requests, part requests or spare parts. Mark it inactive instead',

  FETCH_DROPDOWN_SUCCESS: 'Machine dropdown retrieved successfully',
  FETCH_DROPDOWN_FAILURE: 'Failed to retrieve machine dropdown',
};

const SPARE_PART_MESSAGES = {
  CREATE_SUCCESS: 'Spare part created successfully',
  CREATE_FAILURE: 'Failed to create spare part',

  RETRIEVE_SUCCESS: 'Spare parts retrieved successfully',
  RETRIEVE_FAILURE: 'An error occurred while retrieving spare parts',
  RETRIEVE_ONE_SUCCESS: 'Spare part retrieved successfully',
  NOT_FOUND: 'Spare part not found',
  DUPLICATE_NAME: 'A spare part with this name already exists',

  UPDATE_SUCCESS: 'Spare part updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating spare part',

  UPDATE_STATUS_SUCCESS: 'Spare part active status updated successfully',
  UPDATE_STATUS_FAILURE: 'An error occurred while updating spare part active status',

  DELETE_SUCCESS: 'Spare part deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting spare part',
  DELETE_IN_USE:
    'Cannot delete: Spare part is used in one or more machines, part requests, purchases or stock entries. Mark it inactive instead',

  FETCH_DROPDOWN_SUCCESS: 'Spare part dropdown retrieved successfully',
  FETCH_DROPDOWN_FAILURE: 'Failed to retrieve spare part dropdown',

  UOM_NOT_FOUND: 'Selected unit of measure was not found',
  MACHINE_NOT_FOUND: 'One or more selected machines were not found',
};

const MAINTENANCE_REQUEST_MESSAGES = {
  CREATE_SUCCESS: 'Maintenance request created successfully',
  CREATE_FAILURE: 'Failed to create maintenance request',

  RETRIEVE_SUCCESS: 'Maintenance requests retrieved successfully',
  RETRIEVE_FAILURE: 'An error occurred while retrieving maintenance requests',
  RETRIEVE_ONE_SUCCESS: 'Maintenance request retrieved successfully',
  FETCH_DROPDOWN_SUCCESS: 'Maintenance request dropdown retrieved successfully',
  FETCH_DROPDOWN_FAILURE: 'Failed to retrieve maintenance request dropdown',
  NOT_FOUND: 'Maintenance request not found',

  UPDATE_SUCCESS: 'Maintenance request updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating maintenance request',

  DELETE_SUCCESS: 'Maintenance request deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting maintenance request',
  DELETE_NOT_ALLOWED: 'Only raised or rejected maintenance requests can be deleted',

  APPROVE_SUCCESS: 'Maintenance request approved successfully',
  APPROVE_FAILURE: 'An error occurred while approving maintenance request',
  APPROVE_NOT_ALLOWED: 'Only raised maintenance requests can be approved',

  REJECT_SUCCESS: 'Maintenance request rejected successfully',
  REJECT_FAILURE: 'An error occurred while rejecting maintenance request',
  REJECT_NOT_ALLOWED: 'Only raised maintenance requests can be rejected',

  ASSIGN_SUCCESS: 'Technician assigned successfully',
  ASSIGN_FAILURE: 'An error occurred while assigning technician',
  ASSIGN_NOT_ALLOWED: 'Only approved maintenance requests can be assigned',
  ASSIGNEE_NOT_FOUND: 'Assignee not found',

  START_WORK_SUCCESS: 'Work started successfully',
  START_WORK_FAILURE: 'An error occurred while starting work',
  START_WORK_NOT_ALLOWED: 'Only assigned maintenance requests can be started',

  COMPLETE_SUCCESS: 'Maintenance request marked as completed successfully',
  COMPLETE_FAILURE: 'An error occurred while completing maintenance request',
  COMPLETE_NOT_ALLOWED: 'Only in-progress maintenance requests can be marked as completed',
  COMPLETE_PARTS_NOT_ISSUED: 'Maintenance request cannot be completed until all its part requests are issued',

  CLOSE_SUCCESS: 'Maintenance request closed successfully',
  CLOSE_FAILURE: 'An error occurred while closing maintenance request',
  CLOSE_NOT_ALLOWED: 'Rejected maintenance requests cannot be closed',

  BRANCH_NOT_FOUND: 'Selected branch was not found',
  MACHINE_NOT_FOUND: 'Selected machine was not found',
  MACHINE_INACTIVE: 'Selected machine is inactive',
  USER_NOT_FOUND: 'One or more selected users were not found',
};

const MAINTENANCE_PURCHASE_MESSAGES = {
  CREATE_SUCCESS: 'Purchase request created successfully',
  CREATE_FAILURE: 'Failed to create purchase request',
  MR_NOT_FOUND: 'Linked maintenance request not found',
  SPARE_PART_NOT_FOUND: 'One or more selected spare parts were not found',
  DUPLICATE_SPARE_PART: 'A spare part can only be added once per purchase request',
  PART_REQUEST_ALREADY_PURCHASED: 'A purchase request has already been raised for this part request',
  NOT_FOUND: 'Purchase request not found',
  APPROVE_SUCCESS: 'Purchase request approved successfully',
  APPROVE_FAILURE: 'Failed to approve purchase request',
  APPROVE_NOT_ALLOWED: 'Only purchase requests in PR stage can be approved',
  APPROVE_ITEMS_MISMATCH: 'Approved quantity must be provided exactly once for every item in the purchase request',
  APPROVED_QTY_EXCEEDS: 'Approved quantity cannot exceed the requested quantity',
  RAISE_PO_SUCCESS: 'Purchase order raised successfully',
  RAISE_PO_FAILURE: 'Failed to raise purchase order',
  RAISE_PO_NOT_ALLOWED: 'Purchase order can only be raised for approved purchase requests',
  RETRIEVE_SUCCESS: 'Purchase requests retrieved successfully',
  RETRIEVE_ONE_SUCCESS: 'Purchase request retrieved successfully',
  RETRIEVE_FAILURE: 'An error occurred while retrieving purchase requests',
  FETCH_DROPDOWN_SUCCESS: 'Purchase request dropdown fetched successfully',
  FETCH_DROPDOWN_FAILURE: 'Failed to fetch purchase request dropdown',
  RECEIVE_SUCCESS: 'Goods received successfully',
  RECEIVE_FAILURE: 'Failed to receive goods',
  RECEIVE_NOT_ALLOWED: 'Goods can only be received for purchase orders that are not yet fully received',
  RECEIVE_ITEMS_INVALID: 'Received items must be unique and belong to the purchase order',
  RECEIVE_QTY_EXCEEDS: 'Received quantity cannot exceed the pending ordered quantity',
  RECEIVE_NOTHING: 'At least one item must have a received quantity greater than 0',
  APPROVE_NOTHING: 'At least one item must have an approved quantity greater than 0',
};

const SPARE_STOCK_LEDGER_MESSAGES = {
  SPARE_PART_NOT_FOUND: 'Selected spare part was not found',
  NOT_FOUND: 'Spare stock ledger entries not found',
  RETRIEVE_SUCCESS: 'Spare stock ledger retrieved successfully',
  RETRIEVE_FAILURE: 'Failed to retrieve spare stock ledger',
  ADJUSTMENT_SUCCESS: 'Stock adjustment added successfully',
  ADJUSTMENT_FAILURE: 'Failed to add stock adjustment',
  ADJUSTMENT_EXCEEDS_STOCK: available => `Adjustment would make stock negative. Only ${available} available`,
  STOCK_CANNOT_BE_NEGATIVE: available => `Stock cannot go below zero. Only ${available} available`,
};

const PART_REQUEST_MESSAGES = {
  CREATE_SUCCESS: 'Part request created successfully',
  CREATE_FAILURE: 'Failed to create part request',

  RETRIEVE_SUCCESS: 'Part requests retrieved successfully',
  RETRIEVE_FAILURE: 'An error occurred while retrieving part requests',
  RETRIEVE_ONE_SUCCESS: 'Part request retrieved successfully',
  NOT_FOUND: 'Part request not found',

  UPDATE_SUCCESS: 'Part request updated successfully',
  UPDATE_FAILURE: 'An error occurred while updating part request',
  QTY_LOCKED: 'Requested quantity can only be changed while the part request is pending',

  APPROVE_SUCCESS: 'Part request approved successfully',
  APPROVE_FAILURE: 'An error occurred while approving part request',
  APPROVE_NOT_ALLOWED: 'Only pending part requests can be approved',
  ISSUE_SUCCESS: 'Part request issued successfully',
  ISSUE_FAILURE: 'An error occurred while issuing part request',
  ISSUE_NOT_ALLOWED: 'Only approved part requests can be issued',
  SHORT_SUCCESS: 'Part request marked as short successfully',
  SHORT_FAILURE: 'An error occurred while marking part request as short',
  SHORT_NOT_ALLOWED: 'Only approved part requests can be marked as short',
  STATUS_TRANSITION_NOT_ALLOWED: (from, to) => `Part request cannot move from ${from} to ${to}`,

  DELETE_SUCCESS: 'Part request deleted successfully',
  DELETE_FAILURE: 'An error occurred while deleting part request',
  DELETE_NOT_ALLOWED: 'Only pending part requests can be deleted',

  MR_NOT_FOUND: 'Maintenance request not found',
  MR_CLOSED: 'Parts cannot be requested for a closed or rejected maintenance request',
  SPARE_PART_NOT_FOUND: 'Selected spare part was not found',
  APPROVED_QTY_EXCEEDS: 'Approved quantity cannot exceed the requested quantity',
  ISSUED_QTY_EXCEEDS: 'Issued quantity cannot exceed the approved quantity',
  INSUFFICIENT_STOCK: available => `Insufficient stock to issue this part. Only ${available} available`,
};

const REJECTION_ORDER_MESSAGES = {
  WARRANTY_EXPIRED_QTY_EXCEEDED: 'Warranty expired qty cannot exceed the received qty',
  CREATE_SUCCESS: 'Rejection order created successfully',
  CREATE_FAILURE: 'Failed to create rejection order',

  FETCH_ALL_SUCCESS: 'Rejection orders processed successfully',
  FETCH_ALL_FAILURE: 'Failed to retrieve rejection orders',

  FETCH_ONE_SUCCESS: 'Rejection order fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to retrieve rejection order',
  FETCH_ONE_NOT_FOUND: 'Rejection order not found',

  UPDATE_SUCCESS: 'Rejection order updated successfully',
  UPDATE_FAILURE: 'Failed to update rejection order',
  EDIT_ONLY_PENDING: 'A rejection order can only be edited while it is in Pending status',
  INVALID_REFERENCE_INVOICE: 'Reference invoice not found for the selected customer',
  BOOKED_ITEMS_LOCKED: 'Booked items and quantities can only be changed by editing a Pending rejection order',

  UPDATE_STATUS_SUCCESS: 'Rejection order status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update rejection order status',

  DELETE_SUCCESS: 'Rejection order deleted successfully',
  DELETE_FAILURE: 'Failed to delete rejection order',
  DELETE_RESTRICTED: 'A rejection order cannot be deleted once it has been settled',

  INVENTORY_SUMMARY_SUCCESS: 'Rejection inventory summary fetched successfully',
  INVENTORY_SUMMARY_FAILURE: 'Failed to fetch rejection inventory summary',

  ANALYSIS_SUMMARY_SUCCESS: 'Rejection analysis summary fetched successfully',
  ANALYSIS_SUMMARY_FAILURE: 'Failed to fetch rejection analysis summary',

  WAREHOUSE_NOT_CONFIGURED:
    'Warehouses for return, reuse, and scrap are not configured. Please configure them in Settings before continuing.',
};

const REJECTION_REASON_MESSAGES = {
  CREATE_SUCCESS: 'Rejection reason created successfully',
  CREATE_FAILURE: 'Failed to create rejection reason',

  FETCH_ALL_SUCCESS: 'Rejection reasons retrieved successfully',
  FETCH_ALL_FAILURE: 'Failed to retrieve rejection reasons',

  FETCH_ONE_SUCCESS: 'Rejection reason fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to retrieve rejection reason',
  FETCH_ONE_NOT_FOUND: 'Rejection reason not found',

  UPDATE_SUCCESS: 'Rejection reason updated successfully',
  UPDATE_FAILURE: 'Failed to update rejection reason',

  DELETE_SUCCESS: 'Rejection reason deleted successfully',
  DELETE_FAILURE: 'Failed to delete rejection reason',
  DELETE_HAS_CHILDREN: 'Cannot delete rejection reason that has sub-reasons',
  DELETE_IN_USE: 'Cannot delete rejection reason that is assigned to existing rejection orders',
};

const PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES = {
  CREATE_SUCCESS: 'Production department warehouse configuration created successfully',
  CREATE_FAILURE: 'Failed to create production department warehouse configuration',
  FETCH_ALL_SUCCESS: 'Production department warehouse configurations fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch production department warehouse configurations',
  FETCH_ONE_SUCCESS: 'Production department warehouse configuration fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch production department warehouse configuration',
  UPDATE_SUCCESS: 'Production department warehouse configuration updated successfully',
  UPDATE_FAILURE: 'Failed to update production department warehouse configuration',
  STATUS_SUCCESS: 'Production department warehouse configuration status updated successfully',
  STATUS_FAILURE: 'Failed to update production department warehouse configuration status',
  DELETE_SUCCESS: 'Production department warehouse configuration deleted successfully',
  DELETE_FAILURE: 'Failed to delete production department warehouse configuration',
  FETCH_NOT_FOUND: 'Production department warehouse configuration not found',
  SETTINGS_NOT_FOUND: 'Company settings not found',
  DUPLICATE_NAME: 'A production department warehouse configuration with this department name already exists',
  IN_USE: 'Production department warehouse configuration is used by production orders and cannot be deleted',
};

const INVOICE_DISPATCH_MESSAGES = {
  CREATE_SUCCESS: 'Invoice Dispatch created Successfully',
  FAILED_TO_CREATE: 'Failed to create Invoice Dispatch',
  ALREADY_EXISTS: 'Invoice Dispatch Already Exists for this Invoice',
  UPDATE_SUCCESS: 'Invoice dispatch updated successfully.',
  FAILED_TO_UPDATE: 'Failed to update invoice dispatch.',
  DELETE_FAILURE: 'Failed to delete invoiceDispatch',
  DELETE_SUCCESS: 'Invoice Dispatch deleted successfully',
  NOT_FOUND: 'Invoice Dispatch not found.',
  FETCH_DISPATCH_SUCCESS: 'Dispatch fetched successfully',
  FETCH_DISPATCH_FAILURE: 'Failed to fetch dispatch',
};

const BANK_HISTORY_MESSAGES = {
  CREATE_SUCCESS: 'Bank history created successfully.',
  CREATE_FAILURE: 'Failed to create bank history.',
  FETCH_SUCCESS: 'Bank history fetched successfully.',
  FETCH_FAILURE: 'Failed to fetch bank history.',
  UPDATE_SUCCESS: 'Bank history updated successfully.',
  UPDATE_FAILURE: 'Failed to update bank history.',
  DELETE_SUCCESS: 'Bank history deleted successfully.',
  DELETE_FAILURE: 'Failed to delete bank history.',
  NOT_FOUND: 'Bank history not found.',
};

const ACCOUNTITEM_MASTER_MESSAGES = {
  FETCH_FAILURE: 'Failed to fetch Account master',
  CREATE_SUCCESS: 'Account master created successfully',
  CREATE_FAILURE: 'Failed to create Account master',
  FETCH_ALL_SUCCESS: 'Account master retrieved successfully',
  FETCH_ALL_FAILURE: 'Failed to retrieve Account master',
  UPDATE_SUCCESS: 'Account master updated successfully',
  UPDATE_FAILURE: 'Failed to update Account master',
  FETCH_ONE_NOT_FOUND: 'Account master not found',
  FETCH_DROPDOWN_SUCCESS: 'Account item master dropdown fetched successfully',
  FETCH_DROPDOWN_FAILURE: 'An error occurred while fetching account item master dropdown',
};

const BUSINESS_ACCOUNT_LEDGER_MESSAGES = {
  FETCH_ONE_NOT_FOUND: 'Account Ledger not found',
  DELETE_IN_USE: 'Cannot delete: Account Ledger is used in one or more transactions',
};

const PROFIT_LOSS_MESSAGES = {
  FETCH_SUCCESS: 'Profit/Loss data retrieved successfully',
  FETCH_FAILURE: 'Failed to retrieve profit/loss data',
  FETCH_SUMMARY_SUCCESS: 'Profit/Loss summary retrieved successfully',
  FETCH_SUMMARY_FAILURE: 'Failed to retrieve profit/loss summary',
  FETCH_ITEM_SUCCESS: 'Profit/Loss data by item retrieved successfully',
  FETCH_ITEM_FAILURE: 'Failed to retrieve profit/loss data by item',
  FETCH_ITEM_SUMMARY_SUCCESS: 'Profit/Loss summary by item retrieved successfully',
  FETCH_ITEM_SUMMARY_FAILURE: 'Failed to retrieve profit/loss summary by item',
  FETCH_DOCUMENT_SUCCESS: 'Document details retrieved successfully',
  FETCH_DOCUMENT_FAILURE: 'Failed to retrieve document details',
  FETCH_CUSTOMER_MONTH_WISE_SUCCESS: 'Profit/Loss data by customer month-wise retrieved successfully',
  FETCH_CUSTOMER_MONTH_WISE_FAILURE: 'Failed to retrieve profit/loss data by customer month-wise',
  FETCH_PRODUCTION_ORDER_DETAILS_SUCCESS: 'Production order details retrieved successfully',
  FETCH_PRODUCTION_ORDER_DETAILS_FAILURE: 'Failed to retrieve production order details',
  FETCH_BATCH_SOURCE_BULK_SUCCESS: 'Batch source details retrieved successfully',
  FETCH_BATCH_SOURCE_BULK_FAILURE: 'Failed to retrieve batch source details',

  DOCUMENT_NOT_FOUND: 'Document not found',
  DOCUMENT_OR_ITEM_NOT_FOUND: 'Document or item not found',
  PRODUCTION_ORDER_NOT_FOUND: 'Production Order not found',
};

const MAINTENANCE_MODE_MESSAGES = {
  GET_STATUS_SUCCESS: 'Maintenance status fetched successfully',
  GET_STATUS_FAILURE: 'Failed to fetch maintenance status',
  UPDATE_STATUS_SUCCESS: 'Maintenance status updated',
  UPDATE_STATUS_FAILURE: 'Failed to update maintenance status',
};

const MANUAL_JOURNAL_MESSAGES = {
  CREATE_SUCCESS: 'Manual Journal created successfully',
  CREATE_FAILURE: 'Failed to create Manual Journal',

  GET_SUCCESS: 'Manual Journal retrieved successfully',
  GET_FAILURE: 'Failed to retrieve Manual Journal',

  UPDATE_SUCCESS: 'Manual Journal updated successfully',
  UPDATE_FAILURE: 'Failed to update Manual Journal',

  DELETE_SUCCESS: 'Manual Journal deleted successfully',
  DELETE_FAILURE: 'Failed to delete Manual Journal',

  GET_CONTACT_DROPDOWN_SUCCESS: 'Contact dropdown retrieved successfully',
  GET_CONTACT_DROPDOWN_FAILURE: 'Failed to retrieve contact dropdown',
};

const ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES = {
  CREATE_SUCCESS: 'Item Group Analytics Config created successfully',
  CREATE_FAILURE: 'Failed to create Item Group Analytics Config',

  FETCH_ALL_SUCCESS: 'Item Group Analytics Configs fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch Item Group Analytics Configs',

  UPDATE_SUCCESS: 'Item Group Analytics Config updated successfully',
  UPDATE_FAILURE: 'Failed to update Item Group Analytics Config',

  DELETE_SUCCESS: 'Item Group Analytics Config deleted successfully',
  DELETE_FAILURE: 'Failed to delete Item Group Analytics Config',

  FETCH_ONE_NOT_FOUND: 'Item Group Analytics Config not found',

  FETCH_SUCCESS: 'Item Group Analytics fetched successfully',
  FETCH_FAILURE: 'Failed to fetch Item Group Analytics',
};

const SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES = {
  CREATE_SUCCESS: 'Sub Item Group Analytics Config created successfully',
  CREATE_FAILURE: 'Failed to create Sub Item Group Analytics Config',

  FETCH_ALL_SUCCESS: 'Sub Item Group Analytics Configs fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch Sub Item Group Analytics Configs',

  UPDATE_SUCCESS: 'Sub Item Group Analytics Config updated successfully',
  UPDATE_FAILURE: 'Failed to update Sub Item Group Analytics Config',

  DELETE_SUCCESS: 'Sub Item Group Analytics Config deleted successfully',
  DELETE_FAILURE: 'Failed to delete Sub Item Group Analytics Config',

  FETCH_ONE_NOT_FOUND: 'Sub Item Group Analytics Config not found',

  FETCH_SUCCESS: 'Sub Item Group Analytics fetched successfully',
  FETCH_FAILURE: 'Failed to fetch Sub Item Group Analytics',
};

const ANALYTICS = {
  FETCH_SUCCESS: 'Analytics data fetched successfully',
  FETCH_FAILURE: 'Failed to fetch analytics data',
  FETCH_TOP_SALES_CUSTOMERS_SUCCESS: 'Top sales customers fetched successfully',
  FETCH_TOP_SALES_CUSTOMERS_FAILURE: 'Failed to fetch top sales customers',

  FETCH_PARTY_WISE_BUSINESS_PERFORMANCE_SUCCESS: 'Customer-wise business performance report fetched successfully',
  FETCH_PARTY_WISE_BUSINESS_PERFORMANCE_FAILURE: 'Failed to fetch customer-wise business performance report',
  EXPORT_PARTY_WISE_BUSINESS_PERFORMANCE_FAILURE: 'Failed to export customer-wise business performance report',

  CREATE_SUCCESS: 'General Sales Analytics created successfully',
  CREATE_FAILURE: 'Failed to create General Sales Analytics',

  UPDATE_SUCCESS: 'General Sales Analytics updated successfully',
  UPDATE_FAILURE: 'Failed to update General Sales Analytics',

  DELETE_SUCCESS: 'General Sales Analytics deleted successfully',
  DELETE_FAILURE: 'Failed to delete General Sales Analytics',

  FETCH_ALL_SUCCESS: 'General Sales Analytics fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch General Sales Analytics',

  FETCH_ONE_SUCCESS: 'General Sales Analytics fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch General Sales Analytics',
};

const STOCK_SUMMARY_MESSAGES = {
  FETCH_SUMMARY_SUCCESS: 'Stock summary fetched successfully',
  FETCH_SUMMARY_FAILURE: 'Failed to fetch stock summary',
  FETCH_DATE_WISE_SUCCESS: 'Date-wise stock breakdown fetched successfully',
  FETCH_DATE_WISE_FAILURE: 'Failed to fetch date-wise stock breakdown',
};

const MONTHLY_PRODUCTION_REPORT = {
  FETCH_SUMMARY_SUCCESS: 'Monthly production summary fetched successfully',
  FETCH_SUMMARY_FAILURE: 'Failed to fetch monthly production summary',
  FETCH_DETAIL_ORDERS_SUCCESS: 'Monthly production orders fetched successfully',
  FETCH_DETAIL_ORDERS_FAILURE: 'Failed to fetch monthly production orders',
  FETCH_DETAIL_BY_ITEM_SUCCESS: 'Monthly production item-wise data fetched successfully',
  FETCH_DETAIL_BY_ITEM_FAILURE: 'Failed to fetch monthly production item-wise data',
};

const REJECTION_ANALYTICS = {
  FETCH_SUMMARY_SUCCESS: 'Rejection summary fetched successfully',
  FETCH_SUMMARY_FAILURE: 'Failed to fetch rejection summary',

  FETCH_TREND_SUCCESS: 'Rejection trend fetched successfully',
  FETCH_TREND_FAILURE: 'Failed to fetch rejection trend',

  FETCH_BY_ITEM_SUCCESS: 'Rejection by item fetched successfully',
  FETCH_BY_ITEM_FAILURE: 'Failed to fetch rejection by item',

  FETCH_BY_RAW_MATERIAL_SUCCESS: 'Rejection by raw material fetched successfully',
  FETCH_BY_RAW_MATERIAL_FAILURE: 'Failed to fetch rejection by raw material',

  FETCH_BY_PROCESS_SUCCESS: 'Rejection by process fetched successfully',
  FETCH_BY_PROCESS_FAILURE: 'Failed to fetch rejection by process',

  FETCH_BY_BRANCH_SUCCESS: 'Rejection by branch fetched successfully',
  FETCH_BY_BRANCH_FAILURE: 'Failed to fetch rejection by branch',

  ITEM_REJECTION_REPORT_FETCH_SUCCESS: 'Item rejection report of production order fetched successfully',
  ITEM_REJECTION_REPORT_FETCH_FAILURE: 'Failed to fetch item rejection report of production order',

  ITEM_REJECTION_PRODUCTION_ORDER_LIST_FETCH_SUCCESS: 'Production orders for rejected item fetched successfully',
  ITEM_REJECTION_PRODUCTION_ORDER_LIST_FETCH_FAILURE: 'Failed to fetch production orders for rejected item',
};

const COMMENT_MESSAGE = {
  ADD_SUCCESS: 'Comment added successfully',
  ADD_FAILURE: 'Failed to add comment',
};

const SUPPORT_MESSAGE = {
  CREATE_SUCCESS: 'Support ticket created successfully',
  CREATE_FAILURE: 'Failed to create support ticket',

  FETCH_SUCCESS: 'Support tickets fetched successfully',
  FETCH_FAILURE: 'Failed to fetch support tickets',

  FETCH_ONE_SUCCESS: 'Support ticket fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch support ticket',
  FETCH_ONE_NOT_FOUND: 'Support ticket not found',

  UPDATE_SUCCESS: 'Support ticket updated successfully',
  UPDATE_FAILURE: 'Failed to update support ticket',

  DELETE_SUCCESS: 'Support ticket deleted successfully',
  DELETE_FAILURE: 'Failed to delete support ticket',

  STATUS_UPDATE_SUCCESS: 'Support ticket status updated successfully',
  STATUS_UPDATE_FAILURE: 'Failed to update support ticket status',

  COMMENT_ADDED_SUCCESS: 'Comment added successfully',
  COMMENT_ADDED_FAILURE: 'Failed to add comment',
};

const AGING_REPORT_MESSAGES = {
  GET_AGING_REPORT_SUCCESS: 'Aging report generated successfully',
  GET_AGING_REPORT_FAILURE: 'Failed to generate aging report',
  GET_CUSTOMER_AGING_SUCCESS: 'Customer aging report generated successfully',
  GET_CUSTOMER_AGING_FAILURE: 'Failed to generate customer aging report',
  GET_VENDOR_AGING_SUCCESS: 'Vendor aging report generated successfully',
  GET_VENDOR_AGING_FAILURE: 'Failed to generate vendor aging report',
  GET_CUSTOMER_AGING_DETAILS_SUCCESS: 'Customer aging details retrieved successfully',
  GET_CUSTOMER_AGING_DETAILS_FAILURE: 'Failed to retrieve customer aging details',
  GET_VENDOR_AGING_DETAILS_SUCCESS: 'Vendor aging details retrieved successfully',
  GET_VENDOR_AGING_DETAILS_FAILURE: 'Failed to retrieve vendor aging details',
  GET_CUSTOMER_AGING_BUCKET_SUCCESS: 'Customer aging bucket data retrieved successfully',
  GET_CUSTOMER_AGING_BUCKET_FAILURE: 'Failed to retrieve customer aging bucket data',
  GET_VENDOR_AGING_BUCKET_SUCCESS: 'Vendor aging bucket data retrieved successfully',
  GET_VENDOR_AGING_BUCKET_FAILURE: 'Failed to retrieve vendor aging bucket data',
  GET_UPCOMING_PAYMENTS_SUCCESS: 'Upcoming payments fetched successfully',
  GET_UPCOMING_PAYMENTS_FAILURE: 'Failed to fetch upcoming payments',
};

const DEVELOPMENT_UPDATE_MESSAGE = {
  LIST_SUCCESS: 'Development updates fetched successfully',
  LIST_FAILED: 'Failed to fetch development updates',

  GLOBAL_LIST_SUCCESS: 'Global development updates fetched successfully',
  GLOBAL_LIST_FAILED: 'Failed to fetch global development updates',

  NOT_FOUND: 'Development updates not found',
};

const INCENTIVE_SCHEME_MESSAGES = {
  CREATE_SUCCESS: 'Incentive scheme created successfully',
  CREATE_FAILURE: 'Failed to create incentive scheme',
  FETCH_ALL_SUCCESS: 'Incentive schemes fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch incentive schemes',
  FETCH_ONE_SUCCESS: 'Incentive scheme fetched successfully',
  FETCH_ONE_FAILURE: 'Failed to fetch incentive scheme',
  UPDATE_SUCCESS: 'Incentive scheme updated successfully',
  UPDATE_FAILURE: 'Failed to update incentive scheme',
  DELETE_SUCCESS: 'Incentive scheme deleted successfully',
  DELETE_FAILURE: 'Failed to delete incentive scheme',
  USER_INCENTIVE_SCHEMES_SUCCESS: 'User incentive schemes fetched successfully.',
  USER_INCENTIVE_SCHEMES_FAILURE: 'Failed to fetch user incentive schemes.',
  LOG_UPDATE_SUCCESS: 'Incentive log updated successfully',
  LOG_UPDATE_FAILURE: 'Failed to update incentive log',
  LOG_DELETE_SUCCESS: 'Incentive log deleted successfully',
  LOG_DELETE_FAILURE: 'Failed to delete incentive log',
};

const SALES_ORDER_TAG_MESSAGES = {
  CREATE_SUCCESS: 'Sales order tag created successfully',
  CREATE_FAILURE: 'Failed to create sales order tag',

  FETCH_ALL_SUCCESS: 'Sales order tags fetched successfully',
  FETCH_ALL_FAILURE: 'An error occurred while fetching sales order tags',

  FETCH_DROPDOWN_SUCCESS: 'Sales order tag dropdown fetched successfully',
  FETCH_DROPDOWN_FAILURE: 'An error occurred while fetching sales order tag dropdown',

  FETCH_ONE_SUCCESS: 'Sales order tag fetched successfully',
  FETCH_ONE_NOT_FOUND: 'Sales order tag not found',
  FETCH_ONE_FAILURE: 'An error occurred while fetching sales order tag',

  UPDATE_SUCCESS: 'Sales order tag updated successfully',
  UPDATE_FAILURE: 'Failed to update sales order tag',

  DELETE_SUCCESS: 'Sales order tag deleted successfully',
  DELETE_FAILURE: 'Failed to delete sales order tag',
};

const ITEM_UNIT_MESSAGES = {
  CREATE_SUCCESS: 'Item unit created successfully',
  CREATE_FAILURE: 'Failed to create item unit',

  FETCH_ALL_SUCCESS: 'Item units fetched successfully',
  FETCH_ALL_FAILURE: 'An error occurred while fetching item units',

  FETCH_DROPDOWN_SUCCESS: 'Item unit dropdown fetched successfully',
  FETCH_DROPDOWN_FAILURE: 'An error occurred while fetching item unit dropdown',

  FETCH_ONE_SUCCESS: 'Item unit fetched successfully',
  FETCH_ONE_NOT_FOUND: 'Item unit not found',
  FETCH_ONE_FAILURE: 'An error occurred while fetching item unit',

  UPDATE_SUCCESS: 'Item unit updated successfully',
  UPDATE_FAILURE: 'Failed to update item unit',

  UPDATE_STATUS_SUCCESS: 'Item unit status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update item unit status',

  DELETE_SUCCESS: 'Item unit deleted successfully',
  DELETE_FAILURE: 'Failed to delete item unit',

  DUPLICATE_NAME: 'An item unit with this name already exists in the company',
  IN_USE: 'Item unit cannot be deleted or edited because it is already used in',
  SYSTEM_GENERATED_CANNOT_DELETE: 'System generated item unit cannot be deleted',
  SYSTEM_GENERATED_CANNOT_DEACTIVATE: 'System generated item unit cannot be deactivated',
  FIND_USAGE_SUCCESS: 'Item unit usage fetched successfully',
  FIND_USAGE_FAILURE: 'Failed to fetch item unit usage',
};

const FILE_UPLOAD_MESSAGES = {
  UPLOAD_SUCCESS: 'Files uploaded successfully',
  UPLOAD_FAILURE: 'Error uploading files',
  NO_FILES_UPLOADED: 'No files uploaded',
  COMPANY_NOT_FOUND: 'Company not found',
};

const GST_MESSAGES = {
  FETCH_SUCCESS: 'GST details fetched successfully',
  FETCH_FAILURE: 'Failed to fetch GST details',
  CREDENTIALS_NOT_FOUND:
    'E-Invoice/E-Way Bill credentials are not configured. Please set up your GST portal credentials in Settings before generating.',
  COMPANY_SUBSCRIPTION_NOT_FOUND: 'Company subscription not found',
  PLAN_NOT_FOUND: 'Plan not found',
  COMPANY_NOT_FOUND: 'Company not found',
  APPLICABLE_FEATURE_NOT_CONFIGURED: 'E-invoice/E-way bill feature not configured for this company',
};

const GSTR1_MESSAGES = {
  REPORT_GENERATE_SUCCESS: 'GSTR-1 report generated successfully',
  REPORT_GENERATE_FAILURE: 'Failed to generate GSTR-1 report',
  COMPANY_REQUIRED: 'Company ID is required',
  DATE_RANGE_REQUIRED: 'startDate and endDate are required',
  COMPANY_NOT_FOUND: 'Company not found',
};

const CURRENCY_MESSAGES = {
  CREATE_SUCCESS: 'Currency created successfully',
  CREATE_FAILURE: 'Failed to create currency',

  FETCH_ALL_SUCCESS: 'Currencies fetched successfully',
  FETCH_ALL_FAILURE: 'An error occurred while fetching currencies',

  UPDATE_SUCCESS: 'Currency updated successfully',
  UPDATE_FAILURE: 'Failed to update currency',

  DELETE_SUCCESS: 'Currency deleted successfully',
  DELETE_FAILURE: 'Failed to delete currency',
};

const PAYMENT_TERM_MESSAGES = {
  CREATE_SUCCESS: 'Payment term created successfully',
  CREATE_FAILURE: 'Failed to create payment term',

  FETCH_ALL_SUCCESS: 'Payment terms fetched successfully',
  FETCH_ALL_FAILURE: 'An error occurred while fetching payment terms',

  FETCH_DROPDOWN_SUCCESS: 'Payment terms dropdown fetched successfully',
  FETCH_DROPDOWN_FAILURE: 'An error occurred while fetching payment terms dropdown',

  FETCH_ONE_SUCCESS: 'Payment term fetched successfully',
  FETCH_ONE_FAILURE: 'An error occurred while fetching payment term',
  FETCH_ONE_NOT_FOUND: 'Payment term not found',

  UPDATE_SUCCESS: 'Payment term updated successfully',
  UPDATE_FAILURE: 'Failed to update payment term',
  DAYS_UPDATE_RESTRICTED: 'Days cannot be edited because this payment term is already used in existing documents',

  UPDATE_STATUS_SUCCESS: 'Payment term status updated successfully',
  UPDATE_STATUS_FAILURE: 'Failed to update payment term status',

  SET_DEFAULT_SUCCESS: 'Default payment term set successfully',
  SET_DEFAULT_FAILURE: 'Failed to set default payment term',

  DELETE_SUCCESS: 'Payment term deleted successfully',
  DELETE_FAILURE: 'Failed to delete payment term',
  DELETE_RESTRICTED_IN_USE: 'This payment term cannot be deleted because it is used in existing records',
};

const NOTIFICATION_MESSAGES = {
  FETCH_COUNT_SUCCESS: 'Notification count retrieved successfully',
  FETCH_COUNT_FAILURE: 'Failed to retrieve notification count',
  FETCH_ALL_SUCCESS: 'Notifications fetched successfully',
  FETCH_ALL_FAILURE: 'Failed to fetch notifications',
  GET_PREFERENCE_SUCCESS: 'Notification preference retrieved successfully',
  GET_PREFERENCE_FAILURE: 'Failed to retrieve notification preference',
  UPDATE_PREFERENCE_SUCCESS: 'Notification preference updated successfully',
  UPDATE_PREFERENCE_FAILURE: 'Failed to update notification preference',
  MARK_ALL_READ_SUCCESS: 'All notifications marked as read',
  MARK_ALL_READ_FAILURE: 'Failed to mark notifications as read',
};

const DEVICE_MESSAGES = {
  STORE_TOKEN_SUCCESS: 'Device token stored successfully',
  STORE_TOKEN_FAILURE: 'Failed to store device token',
};

const PROBLEM_LIST_MESSAGES = {
  CREATE_SUCCESS: 'Problem created successfully',
  CREATE_FAILURE: 'Failed to create problem',

  FETCH_ALL_SUCCESS: 'Problem list fetched successfully',
  FETCH_ALL_FAILURE: 'An error occurred while fetching problem list',

  FETCH_ONE_SUCCESS: 'Problem fetched successfully',
  FETCH_ONE_NOT_FOUND: 'Problem not found',
  FETCH_ONE_FAILURE: 'An error occurred while fetching problem',

  UPDATE_SUCCESS: 'Problem updated successfully',
  UPDATE_FAILURE: 'Failed to update problem',

  DELETE_SUCCESS: 'Problem deleted successfully',
  DELETE_FAILURE: 'Failed to delete problem',
  DELETE_HAS_CHILDREN: 'Cannot delete this problem because it has child problems',
  DELETE_SYSTEM_GENERATED: 'A system generated problem cannot be deleted',
  DELETE_IN_USE: 'Cannot delete this problem because it is used in one or more complaints',

  DUPLICATE_NAME: 'A problem with this name already exists under the same parent',
  PARENT_NOT_FOUND: 'Parent problem not found',
  INVALID_PARENT: 'A problem cannot be its own parent',
  INVALID_PARENT_CYCLE: 'Cannot move a problem under one of its own descendants',
};

const COMPLAINT_MESSAGES = {
  CREATE_SUCCESS: 'Complaint created successfully',
  CREATE_FAILURE: 'Failed to create complaint',

  FETCH_ALL_SUCCESS: 'Complaints fetched successfully',
  FETCH_ALL_FAILURE: 'An error occurred while fetching complaints',

  FETCH_DROPDOWN_SUCCESS: 'Complaints dropdown fetched successfully',
  FETCH_DROPDOWN_FAILURE: 'Failed to fetch complaints dropdown',

  FETCH_ONE_SUCCESS: 'Complaint fetched successfully',
  FETCH_ONE_NOT_FOUND: 'Complaint not found',
  FETCH_ONE_FAILURE: 'An error occurred while fetching complaint',

  UPDATE_SUCCESS: 'Complaint updated successfully',
  UPDATE_FAILURE: 'Failed to update complaint',

  DELETE_SUCCESS: 'Complaint deleted successfully',
  DELETE_FAILURE: 'Failed to delete complaint',
  DELETE_NOT_ALLOWED: 'Only complaints in New step can be deleted',

  PROBLEM_NOT_FOUND: 'Selected problem not found',
  INVALID_FORM_TYPE: 'Invalid complaint form type for the selected problem',
  EVIDENCE_REQUIRED: 'Required evidence is missing for this problem',
  INVALID_STEP: 'This action is not allowed on the current step',
  STEP_INCOMPLETE: 'Finish the required items for this step first',
  SKIP_NOT_ALLOWED: 'This step cannot be skipped for product / replacement complaints',
  STEP_ASSIGN_SUCCESS: 'Complaint assigned successfully',
  STEP_REPLY_SUCCESS: 'Customer reply saved successfully',
  STEP_START_PROGRESS_SUCCESS: 'Complaint moved to In Progress',
  STEP_WARRANTY_SUCCESS: 'Warranty position saved successfully',
  STEP_ROOT_CAUSE_SUCCESS: 'Root cause saved successfully',
  STEP_STOP_GAP_SUCCESS: 'Stop-gap action saved successfully',
  STEP_RECORD_PROGRESS_SUCCESS: 'In Progress recorded successfully',
  STEP_SETTLEMENT_SUCCESS: 'Settlement saved successfully',
  STEP_COMPLETE_ACTION_SUCCESS: 'Action Taken completed successfully',
  STEP_VERIFY_SUCCESS: 'Verification saved successfully',
  STEP_CLOSE_SUCCESS: 'Complaint closed successfully',
  STEP_SKIP_SUCCESS: 'Step skipped successfully',

  TEAM_NOTE_SUCCESS: 'Team note added successfully',
  TEAM_TASK_SUCCESS: 'Team task added successfully',
  TEAM_TASK_UPDATE_SUCCESS: 'Team task updated successfully',

  ACTION_HAND_OVER_SUCCESS: 'Complaint handed to someone else successfully',
  ACTION_WAITING_SUCCESS: 'Complaint marked as waiting successfully',
  ACTION_WAITING_CLEARED_SUCCESS: 'Waiting cleared successfully',
  ACTION_ESCALATE_SUCCESS: 'Complaint escalated successfully',
  ACTION_LINK_SUCCESS: 'Complaints linked successfully',
  ACTION_NOT_REAL_SUCCESS: 'Complaint marked as not a real complaint',
  ACTION_NOT_ALLOWED: 'This action is not allowed on the current complaint',
  ALREADY_NOT_REAL: 'Complaint is already marked as not a real complaint',
  ALREADY_CLOSED: 'Complaint is already closed',
  NOT_CLOSED: 'Only a closed complaint can be reopened',
  ALREADY_WAITING: 'Complaint is already waiting on someone',
  NOT_WAITING: 'Complaint is not waiting',
  LINK_SELF_NOT_ALLOWED: 'Cannot link a complaint to itself',
  LINK_TARGET_NOT_FOUND: 'Linked complaint not found',
  LINK_ALREADY_EXISTS: 'These complaints are already linked',
  ACTION_REOPEN_SUCCESS: 'Complaint reopened successfully',
};

const ONBOARDING_MESSAGES = {
  FETCH_STATUS_SUCCESS: 'Onboarding status fetched successfully',
  FETCH_STATUS_FAILURE: 'Failed to fetch onboarding status',
  UPDATE_STEP_SUCCESS: 'Onboarding step updated successfully',
  UPDATE_STEP_FAILURE: 'Failed to update onboarding step',
  SET_DISMISSED_SUCCESS: 'Onboarding preference updated successfully',
  SET_DISMISSED_FAILURE: 'Failed to update onboarding preference',
  FETCH_DATA_SETUP_STATUS_SUCCESS: 'Data setup status fetched successfully',
  FETCH_DATA_SETUP_STATUS_FAILURE: 'Failed to fetch data setup status',
  FETCH_DATA_SETUP_PREVIEW_SUCCESS: 'Data setup preview fetched successfully',
  FETCH_DATA_SETUP_PREVIEW_FAILURE: 'Failed to fetch data setup preview',
  RUN_DATA_SETUP_SUCCESS: 'Data setup backfill completed successfully',
  RUN_DATA_SETUP_FAILURE: 'Failed to run data setup backfill',
};

module.exports = {
  ACCOUNT_MESSAGES,
  BANK_MESSAGES,
  BILL_MESSAGES,
  BRANCH_MESSAGES,
  CREDIT_NOTE_MESSAGES,
  CUSTOMER_MESSAGES,
  DELIVERY_CHALLAN_MESSAGES,
  DIVISION_MESSAGES,
  EXPENSE_MESSAGES,
  INVENTORY_ADJUSTMENT_MESSAGES,
  INVENTORY_TRANSFER_MESSAGES,
  INVENTORY_LOGS_MESSAGES,
  ITEM_BATCH_MESSAGES,
  INVOICE_MESSAGES,
  ITEM_MESSAGES,
  ITEM_GROUP_MESSAGES,
  SUB_ITEM_GROUP_MESSAGES,
  MODULE_MESSAGES,
  MODULE_SETTINGS_MESSAGES,
  OPENING_BALANCE_TRANSACTION_MESSAGES,
  PAYMENT_MESSAGES,
  PAYMENT_MADE_MESSAGES,
  PRICE_LIST_MESSAGES,
  PROCESS_MESSAGES,
  PRODUCTION_ORDER_MESSAGES,
  PROJECT_MESSAGES,
  PURCHASE_ORDER_MESSAGES,
  QC_MASTER_MESSAGES,
  QUOTE_MESSAGES,
  RECIPE_MESSAGES,
  RECURRING_BILL_MESSAGES,
  RECURRING_EXPENSE_MESSAGES,
  RECURRING_INVOICE_MESSAGES,
  REPORT_MESSAGES,
  ROLE_MESSAGES,
  SALES_ORDER_MESSAGES,
  TAX_MESSAGES,
  TIMESHEET_MESSAGES,
  TRANSPORT_COURIER_MESSAGES,
  USER_MESSAGES,
  WAREHOUSE_MESSAGES,
  CRON_LOGS_MESSAGES,
  AUTH_MESSAGES,
  COMPANY_MESSAGES,
  GRPO_ORDER_MESSAGES,
  DEBIT_NOTE_MESSAGES,
  STOCK,
  DASHBOARD_MESSAGES,
  SALES_DASHBOARD_MESSAGES,
  LEDGER_MESSAGES,
  LOCATION_MESSAGES,
  MANPOWER_MESSAGES,
  MACHINE_MESSAGES,
  SPARE_PART_MESSAGES,
  MAINTENANCE_REQUEST_MESSAGES,
  PART_REQUEST_MESSAGES,
  SPARE_STOCK_LEDGER_MESSAGES,
  MAINTENANCE_PURCHASE_MESSAGES,
  REJECTION_ORDER_MESSAGES,
  REJECTION_REASON_MESSAGES,
  PRODUCTION_DEPT_WAREHOUSE_CONFIG_MESSAGES,
  INVOICE_DISPATCH_MESSAGES,
  BANK_HISTORY_MESSAGES,
  ACCOUNTITEM_MASTER_MESSAGES,
  BUSINESS_ACCOUNT_LEDGER_MESSAGES,
  PROFIT_LOSS_MESSAGES,
  MAINTENANCE_MODE_MESSAGES,
  MANUAL_JOURNAL_MESSAGES,
  ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES,
  SUB_ITEM_GROUP_ANALYTICS_CONFIG_MESSAGES,
  ANALYTICS,
  REJECTION_ANALYTICS,
  MONTHLY_PRODUCTION_REPORT,
  STOCK_SUMMARY_MESSAGES,
  COMMENT_MESSAGE,
  SUPPORT_MESSAGE,
  AGING_REPORT_MESSAGES,
  DEVELOPMENT_UPDATE_MESSAGE,
  SALES_ORDER_TAG_MESSAGES,
  ITEM_UNIT_MESSAGES,
  CURRENCY_MESSAGES,
  CUSTOMER_ORDER_MESSAGES,
  SAMPLE_CATALOG_MESSAGES,
  FILE_UPLOAD_MESSAGES,
  GST_MESSAGES,
  GSTR1_MESSAGES,
  INCENTIVE_SCHEME_MESSAGES,
  NOTIFICATION_MESSAGES,
  DEVICE_MESSAGES,
  ONBOARDING_MESSAGES,
  PAYMENT_TERM_MESSAGES,
  PROBLEM_LIST_MESSAGES,
  COMPLAINT_MESSAGES,
};
