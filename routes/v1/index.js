const express = require('express');
const authRoute = require('../../modules/auth/auth.route');
const userRoute = require('../../modules/setting/user/user.route');
const divisionRoute = require('../../modules/allMaster/division/division.route');
const branchRoute = require('../../modules/allMaster/branch/branch.route');
const moduleRoute = require('../../modules/commonModule/module/module.route');
const moduleSettingsRoute = require('../../modules/commonModule/moduleSetting/moduleSettings.route');
const paymentTermRoute = require('../../modules/commonModule/paymentTerm/paymentTerm.route');
const taxRoute = require('../../modules/commonModule/tax/tax.route');
const warehouseRoute = require('../../modules/allMaster/warehouse/warehouse.route');
const config = require('../../config/config');
const roleRoute = require('../../modules/setting/role/role.route');
const customerMaster = require('../../modules/sales/customerMaster/customerMaster.route');
const qualityMaster = require('../../modules/allMaster/qualityMaster/qualityMaster.route');
const processRoute = require('../../modules/allMaster/process/process.route');
const recipeRoute = require('../../modules/allMaster/recipe/recipe.route');
const priceListRoute = require('../../modules/allMaster/priceList/priceList.route');
const itemRoute = require('../../modules/allMaster/item/item.route');
const itemGroupRoute = require('../../modules/allMaster/itemGroup/itemGroup.route');
const subItemGroupRoute = require('../../modules/allMaster/subItemGroup/subItemGroup.route');
const quoteRoute = require('../../modules/sales/quote/quote.route');
const customerOrderRoute = require('../../modules/sales/customerOrder/customerOrder.route');
const customerPaymentRoute = require('../../modules/sales/customerPayment/customerPayment.route');
const sampleCatalogRoute = require('../../modules/sales/sampleCatalog/sampleCatalog.route');
const salesOrderRoute = require('../../modules/sales/salesOrder/salesOrder.route');
const deliveryChallanRoute = require('../../modules/sales/deliveryChallan/deliveryChallan.route');
const rejectionOrderRoute = require('../../modules/rejection/rejectionOrder/rejectionOrder.route');
const rejectionReasonRoute = require('../../modules/rejection/rejectionReason/rejectionReason.route');
const invoiceRoute = require('../../modules/sales/invoice/invoice.route');
const bankRoute = require('../../modules/banking/bank/bank.route');
const expenseRoute = require('../../modules/purchase/expense/expense.route');
const paymentReceivedRoute = require('../../modules/sales/paymentReceived/paymentReceived.route');
const recurringInvoiceRoute = require('../../modules/sales/recurringInvoice/recurringInvoice.route');
const creditNoteRoute = require('../../modules/sales/creditNote/creditNote.route');
const accountRoute = require('../../modules/accountant/chartOfAccount/account.route');
const purchaseOrderRoute = require('../../modules/purchase/purchaseOrder/purchaseOrder.route');
const grpoOrderRoute = require('../../modules/purchase/grpo/grpoOrder.route');
const billRoute = require('../../modules/purchase/bill/bill.route');
const paymentMadeRoute = require('../../modules/purchase/paymentMade/paymentMade.route');
const recurringExpense = require('../../modules/purchase/recurringExpense/recurringExpense.route');
const recurringBill = require('../../modules/purchase/recurringBill/recurringBill.route');
const debitNote = require('../../modules/purchase/debitNote/debitNote.route');
const companyProfileRoute = require('../../modules/setting/companyProfile/companyprofile.route');
const dashboardRoute = require('../../modules/dashboard/dashboard/dashboard.route');
const reportRoute = require('../../modules/report/report/report.route');
const maintenanceModeRoute = require('../../modules/commonModule/maintenance/maintenanceMode.route');
const productionOrderRoute = require('../../modules/production/addProduction/productionOrder.route');
const manPowerRoute = require('../../modules/allMaster/manPower/manPower.route');
const machineRoute = require('../../modules/maintenance/machine/machine.route');
const sparePartRoute = require('../../modules/maintenance/sparePart/sparePart.route');
const maintenanceRequestRoute = require('../../modules/maintenance/maintenanceRequest/maintenanceRequest.route');
const maintenancePurchaseRoute = require('../../modules/maintenance/maintenancePurchase/maintenancePurchase.route');
const partRequestRoute = require('../../modules/maintenance/partRequest/partRequest.route');
const spareStockLedgerRoute = require('../../modules/maintenance/spareStockLedger/spareStockLedger.route');
const transportCourier = require('../../modules/sales/transportCourier/transportCourier.route');
const invoiceDispatch = require('../../modules/sales/invoiceDispatch/invoiceDispatch.route');
const businessAccountLedgerMaster = require('../../modules/accountant/accountLedger/accountLedger.route');
const inventoryLogs = require('../../modules/Inventory/inventoryLogs/inventoryLogs.route');
const profitLoss = require('../../modules/report/profitLoss/profitLoss.route');
const manualJournal = require('../../modules/accountant/manualJournal/manualJournal.route');
const ledgerRoute = require('../../modules/accountant/ledger/ledger.route');
const itemGroupAnalyticsConfigRoute = require('../../modules/analytics/itemGroupAnalyticsConfig/itemGroupAnalyticsConfig.route');
const subItemGroupAnalyticsConfigRoute = require('../../modules/analytics/subItemGroupAnalyticsConfig/subItemGroupAnalyticsConfig.route');
const inventoryAdjustmentRoute = require('../../modules/Inventory/inventoryAdjustment/inventoryAdjustment.route');
const inventoryTransferRoute = require('../../modules/Inventory/inventoryTransfer/inventoryTransfer.route');
const itemBatchRoute = require('../../modules/Inventory/itemBatch/itemBatch.route');
const analyticsRoute = require('../../modules/analytics/analytics/analytics.route');
const rejectionAnalyticsRoute = require('../../modules/analytics/rejectionAnalytics/rejectionAnalytics.route');
const productionReportRoute = require('../../modules/analytics/productionReport/productionReport.route');
const stockSummaryRoute = require('../../modules/analytics/stockSummary/stockSummary.route');
const salesDashboardRoute = require('../../modules/dashboard/salesDashboard/salesDashboard.route');
const productionDashboardRoute = require('../../modules/dashboard/productionDashboard/productionDashboard.route');
const onboardingRoute = require('../../modules/dashboard/onboarding/onboarding.route');
const gstRoute = require('../../modules/report/gst/gst.route');
const supportRoute = require('../../modules/support/support.route');
const agingreportRoute = require('../../modules/report/agingReport/agingreport.route');
const gstr1Route = require('../../modules/report/gstr1/gstr1.route');
const developmentUpdateRoute = require('../../modules/commonModule/developmentUpdate/developmentUpdate.route');
const commentRoute = require('../../modules/commonModule/comment/comment.route');
const openingBalanceTransactionRoute = require('../../modules/sales/openingBalanceTransaction/openingBalanceTransaction.route');
const salesOrderTagRoute = require('../../modules/allMaster/salesOrderTag/salesOrderTag.route');
const itemUnitRoute = require('../../modules/allMaster/itemUnit/itemUnit.route');
const currencyRoute = require('../../modules/setting/currency/currency.route');
const thirdPartyCredentialsRoute = require('../../modules/setting/thirdPartyCredentials/thirdPartyCredentials.route');
const incentiveSchemeRoute = require('../../modules/setting/incentiveScheme/incentiveScheme.route');
const notificationRoute = require('../../modules/commonModule/notification/notification.route');
const deviceRoute = require('../../modules/commonModule/device/device.route');
const documentExportRoute = require('../../modules/commonModule/documentExport/documentExport.route');
const masterLocationRoute = require('../../modules/masterLocation/masterLocation.route');
const problemListRoute = require('../../modules/problemList/problemList.route');
const complaintRoute = require('../../modules/complaint/complaint.route');
const productionDepartmentWarehouseConfigRoute = require('../../modules/setting/productionDepartmentWarehouseConfig/productionDepartmentWarehouseConfig.route');
const { authorize } = require('../../middlewares/auth.js');

const router = express.Router();

router.use(authorize);

const defaultRoutes = [
  {
    path: '/auth',
    route: authRoute,
  },
  {
    path: '/users',
    route: userRoute,
  },
  {
    path: '/division',
    route: divisionRoute,
  },
  {
    path: '/module',
    route: moduleRoute,
  },
  {
    path: '/moduleSettings',
    route: moduleSettingsRoute,
  },
  {
    path: '/paymentTerm',
    route: paymentTermRoute,
  },
  {
    path: '/tax',
    route: taxRoute,
  },
  {
    path: '/branch',
    route: branchRoute,
  },
  {
    path: '/warehouse',
    route: warehouseRoute,
  },
  {
    path: '/customer',
    route: customerMaster,
  },
  {
    path: '/qualityMaster',
    route: qualityMaster,
  },
  {
    path: '/roles',
    route: roleRoute,
  },
  {
    path: '/process',
    route: processRoute,
  },
  {
    path: '/dashboard',
    route: dashboardRoute,
  },
  {
    path: '/sales-dashboard',
    route: salesDashboardRoute,
  },
  {
    path: '/production-dashboard',
    route: productionDashboardRoute,
  },
  {
    path: '/onboarding',
    route: onboardingRoute,
  },
  {
    path: '/recipe',
    route: recipeRoute,
  },
  {
    path: '/item',
    route: itemRoute,
  },
  {
    path: '/itemGroup',
    route: itemGroupRoute,
  },
  {
    path: '/subItemGroup',
    route: subItemGroupRoute,
  },
  {
    path: '/quote',
    route: quoteRoute,
  },
  {
    path: '/customerOrder',
    route: customerOrderRoute,
  },
  {
    path: '/customerPayment',
    route: customerPaymentRoute,
  },
  {
    path: '/sampleCatalog',
    route: sampleCatalogRoute,
  },
  {
    path: '/salesOrder',
    route: salesOrderRoute,
  },
  {
    path: '/deliveryChallan',
    route: deliveryChallanRoute,
  },
  {
    path: '/rejectionOrder',
    route: rejectionOrderRoute,
  },
  {
    path: '/rejectionReason',
    route: rejectionReasonRoute,
  },
  {
    path: '/invoice',
    route: invoiceRoute,
  },
  {
    path: '/priceList',
    route: priceListRoute,
  },
  {
    path: '/banks',
    route: bankRoute,
  },
  {
    path: '/expenses',
    route: expenseRoute,
  },
  {
    path: '/paymentReceived',
    route: paymentReceivedRoute,
  },
  {
    path: '/recurringInvoice',
    route: recurringInvoiceRoute,
  },
  {
    path: '/creditNote',
    route: creditNoteRoute,
  },
  {
    path: '/account',
    route: accountRoute,
  },
  {
    path: '/purchaseOrder',
    route: purchaseOrderRoute,
  },
  {
    path: '/grpoOrder',
    route: grpoOrderRoute,
  },
  {
    path: '/bill',
    route: billRoute,
  },
  {
    path: '/paymentMade',
    route: paymentMadeRoute,
  },
  {
    path: '/recurringBill',
    route: recurringBill,
  },
  {
    path: '/recurringExpense',
    route: recurringExpense,
  },
  {
    path: '/debitNote',
    route: debitNote,
  },
  {
    path: '/company',
    route: companyProfileRoute,
  },
  {
    path: '/reports',
    route: reportRoute,
  },
  {
    path: '/maintenanceMode',
    route: maintenanceModeRoute,
  },
  {
    path: '/productionOrder',
    route: productionOrderRoute,
  },
  {
    path: '/manPower',
    route: manPowerRoute,
  },
  {
    path: '/machine',
    route: machineRoute,
  },
  {
    path: '/sparePart',
    route: sparePartRoute,
  },
  {
    path: '/maintenanceRequest',
    route: maintenanceRequestRoute,
  },
  {
    path: '/maintenancePurchase',
    route: maintenancePurchaseRoute,
  },
  {
    path: '/partRequest',
    route: partRequestRoute,
  },
  {
    path: '/spareStockLedger',
    route: spareStockLedgerRoute,
  },
  {
    path: '/transportCourier',
    route: transportCourier,
  },
  {
    path: '/invoiceDispatch',
    route: invoiceDispatch,
  },
  {
    path: '/businessAccountLedgerMaster',
    route: businessAccountLedgerMaster,
  },
  {
    path: '/inventoryLogs',
    route: inventoryLogs,
  },
  {
    path: '/profitLoss',
    route: profitLoss,
  },
  {
    path: '/manualJournal',
    route: manualJournal,
  },
  {
    path: '/ledger',
    route: ledgerRoute,
  },
  {
    path: '/itemGroupAnalyticsConfig',
    route: itemGroupAnalyticsConfigRoute,
  },
  {
    path: '/subItemGroupAnalyticsConfig',
    route: subItemGroupAnalyticsConfigRoute,
  },
  {
    path: '/inventoryAdjustment',
    route: inventoryAdjustmentRoute,
  },
  {
    path: '/inventoryTransfer',
    route: inventoryTransferRoute,
  },
  {
    path: '/itemBatch',
    route: itemBatchRoute,
  },
  {
    path: '/analytics',
    route: analyticsRoute,
  },
  {
    path: '/analytics/rejection',
    route: rejectionAnalyticsRoute,
  },
  {
    path: '/analytics/production',
    route: productionReportRoute,
  },
  {
    path: '/analytics/stock',
    route: stockSummaryRoute,
  },
  {
    path: '/gst',
    route: gstRoute,
  },
  {
    path: '/support',
    route: supportRoute,
  },
  {
    path: '/agingreport',
    route: agingreportRoute,
  },
  {
    path: '/gstr1',
    route: gstr1Route,
  },
  {
    path: '/development-update',
    route: developmentUpdateRoute,
  },
  {
    path: '/comment',
    route: commentRoute,
  },
  {
    path: '/opening-balance-transaction',
    route: openingBalanceTransactionRoute,
  },
  {
    path: '/salesOrderTag',
    route: salesOrderTagRoute,
  },
  {
    path: '/itemUnit',
    route: itemUnitRoute,
  },
  {
    path: '/currency',
    route: currencyRoute,
  },
  {
    path: '/third-party-credentials',
    route: thirdPartyCredentialsRoute,
  },
  {
    path: '/incentive-schemes',
    route: incentiveSchemeRoute,
  },
  {
    path: '/notifications',
    route: notificationRoute,
  },
  {
    path: '/document-exports',
    route: documentExportRoute,
  },
  {
    path: '/devices',
    route: deviceRoute,
  },
  {
    path: '/masterLocation',
    route: masterLocationRoute,
  },
  {
    path: '/problemList',
    route: problemListRoute,
  },
  {
    path: '/complaints',
    route: complaintRoute,
  },
  {
    path: '/productionWarehouseConfig',
    route: productionDepartmentWarehouseConfigRoute,
  },
];

const devRoutes = [
  // routes available only in development mode
];

defaultRoutes.forEach(route => {
  router.use(route.path, route.route);
});

/* istanbul ignore next */
if (config.env === 'development') {
  devRoutes.forEach(route => {
    router.use(route.path, route.route);
  });
}

module.exports = router;
