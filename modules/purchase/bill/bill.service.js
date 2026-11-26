const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const moment = require('moment');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { getPurchaseAddressCondition, getPurchaseAddressResolver } = require('../../../utils/addressLocationFilter');
const { pairLinesWithExisting, createLineClaimer } = require('../../../utils/documentLineMatching');
const {
  BILL_STATUSES,
  LEDGER_SOURCE_MODULES,
  PO_STATUSES,
  GRPO_STATUSES,
  MODULE_NAMES,
  TRANSACTION_TYPE,
  OB_PAYMENT_ENTRY_SOURCE,
  CONTACT_TYPE,
  PAYMENT_STATUS,
  DEBIT_NOTE_STATUS,
  LEDGER_PARTY_TYPES,
} = require('../../../utils/enum');
const ApiError = require('../../../utils/ApiError');
const { assertLineUnitsValid } = require('../../../services/documentItemEnricher.service');
const { GRPO_CONVERSION_ALLOWED_STATUSES } = require('../grpo/grpoOrder.service');
const {
  BILL_STATUS_CONFIG,
  getInventoryConfig,
  validateStatusTransition,
  validateEditPermissions,
} = require('../../../utils/inventoryConfig');
const { getBooksCrmModels, getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { generateUniqueId, generateMultipleUniqueIdsForModules } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');
const { defaultBranchEntry, multipleDefaultBranchEntry } = require('../../../utils/defaultCustomerBranchEntry');
const { moveAdvanceApplyBranchBalances } = require('../../../utils/paymentBranchBalance');
const mongoose = require('mongoose');
const { exportToExcel } = require('../../../utils/excelExport');
const billTransformers = require('./bill.transformer');
const { handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const {
  handleWarehouseStock,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
  adjustStockByBatchId,
  deleteStockByBatchId,
} = require('../../../services/warehouseBatch.service');
const { validateVendorForModule, updateBranchCurrentBalance } = require('../../../services/customerValidation.service');
const { preparePurchaseDocumentSave, getSourceItemIds } = require('../../../services/purchaseDocumentGuard.service');
const { enrichObLines, obLinesFromPaymentsMade } = require('../../../utils/openingBalancePaymentHistoryHelper');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { BILL_MESSAGES } = require('../../../utils/messages');
const { attachBranchNames } = require('../../../utils/helper');
const { getCompanyProfile } = require('../../../services/onboard.service');
const { recomputePurchaseOrderStatus } = require('../../../services/conversionStatus.service');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const { attachItemSummaries } = require('../../../services/documentItemSummary.service');
const {
  sendModuleCustomerNotifications,
  notifyModuleDocumentIfNonDraft,
  isFirstStatusChange,
} = require('../../../services/moduleEmailNotification.service');
const logger = require('../../../config/logger');

// Replace the bill journal when crossing draft/cancelled ↔ posted; skip when only payment status changes.
const syncBillJournal = async (companyId, bill, userId, session, oldStatus = null) => {
  const POSTED_BILL_STATUSES = [
    BILL_STATUSES.DRAFT,
    BILL_STATUSES.OPEN,
    BILL_STATUSES.PARTIALLY_PAID,
    BILL_STATUSES.PAID,
    BILL_STATUSES.OVERDUE,
  ];
  const isPostedBillStatus = status => POSTED_BILL_STATUSES.includes(status);
  const wasPosted = oldStatus != null && isPostedBillStatus(oldStatus);
  const isPosted = isPostedBillStatus(bill.status);

  // Open → partly paid → paid keeps the same bill journal; no reverse/re-post needed.
  if (oldStatus != null && wasPosted && isPosted) {
    return;
  }

  // Clear any existing bill journal, then post again only if the bill is in a posted status.
  await ledgerService.deleteJournal({ companyId, sourceModule: LEDGER_SOURCE_MODULES.BILL, sourceId: bill._id }, session);
  if (isPosted) {
    await ledgerService.postBillJournal({ companyId, bill, addedBy: userId }, session);
  }
};

const updateBillPaymentStatus = async (billId, amount, userId = null, session = null) => {
  try {
    const { Bill } = getBooksModels();
    const bill = await Bill.findById(billId).session(session);
    if (!bill) {
      return false;
    }

    const newPaidAmount = bill.paidAmount + amount;
    const newBalanceAmount = bill.total - newPaidAmount;

    const todayDate = new Date();
    todayDate.setUTCHours(0, 0, 0, 0);

    if (newPaidAmount < bill.total && bill.dueDate && bill.dueDate < todayDate) {
      const update = {
        paidAmount: newPaidAmount,
        balanceAmount: newBalanceAmount,
        status: BILL_STATUSES.OVERDUE,
      };
      if (bill.status !== BILL_STATUSES.OVERDUE) {
        update.$push = {
          commentHistory: {
            message: `Bill status updated from ${bill.status} to ${BILL_STATUSES.OVERDUE}`,
            addedBy: userId,
            createdAt: new Date(),
            referenceType: 'BILL',
            referenceId: billId,
          },
        };
      }

      await Bill.updateOne({ _id: billId }, update, { session });

      return true;
    }

    let status = bill.status;
    if (newPaidAmount >= bill.total) {
      status = BILL_STATUSES.PAID;
    } else if (newPaidAmount > 0) {
      status = BILL_STATUSES.PARTIALLY_PAID;
    } else {
      status = BILL_STATUSES.OPEN;
    }

    const update = {
      paidAmount: newPaidAmount,
      balanceAmount: newBalanceAmount,
      status,
    };
    if (bill.status !== status) {
      update.$push = {
        commentHistory: {
          message: `Bill status updated from ${bill.status} to ${status}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'BILL',
          referenceId: billId,
        },
      };
    }

    await Bill.updateOne({ _id: billId }, update, { session });

    return true;
  } catch (error) {
    console.error('Error updating bill payment status:', error);
    throw error;
  }
};

const cancelBillPayment = async (billId, amount, userId = null, session = null) => {
  try {
    const { Bill } = getBooksModels();
    const bill = await Bill.findById(billId).session(session);
    if (!bill) {
      return false;
    }

    const newPaidAmount = bill.paidAmount - amount;
    const newBalanceAmount = bill.balanceAmount + amount;

    const todayDate = new Date();
    todayDate.setUTCHours(0, 0, 0, 0);

    if (newPaidAmount < bill.total && bill.dueDate && bill.dueDate < todayDate) {
      const update = {
        paidAmount: newPaidAmount,
        balanceAmount: newBalanceAmount,
        status: BILL_STATUSES.OVERDUE,
      };
      if (bill.status !== BILL_STATUSES.OVERDUE) {
        update.$push = {
          commentHistory: {
            message: `Bill status updated from ${bill.status} to ${BILL_STATUSES.OVERDUE}`,
            addedBy: userId,
            createdAt: new Date(),
            referenceType: 'BILL',
            referenceId: billId,
          },
        };
      }

      await Bill.updateOne({ _id: billId }, update, { session });

      return true;
    }

    let status = bill.status;
    if (newPaidAmount >= bill.total) {
      status = BILL_STATUSES.PAID;
    } else if (newPaidAmount > 0) {
      status = BILL_STATUSES.PARTIALLY_PAID;
    } else {
      status = BILL_STATUSES.OPEN;
    }

    const update = {
      paidAmount: newPaidAmount,
      balanceAmount: newBalanceAmount,
      status,
    };
    if (bill.status !== status) {
      update.$push = {
        commentHistory: {
          message: `Bill status updated from ${bill.status} to ${status}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'BILL',
          referenceId: billId,
        },
      };
    }

    await Bill.updateOne({ _id: billId }, update, { session });

    return true;
  } catch (error) {
    console.error('Error updating bill payment status:', error);
    throw error;
  }
};

const createBill = async (billBody, userId, uploadedFiles = []) => {
  const { Customer, Branch } = getBooksCrmModels();
  const { Bill, PurchaseOrder, GrpoOrder } = getBooksModels();
  const { CompanySettings, Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const {
      warehouseId,
      purchaseOrderId,
      vendor,
      total,
      branchId,
      purchaseOrders,
      grpoId,
      companyId,
      items = [],
      isSplit,
      grpoIds,
      isInventoryEnabled,
    } = billBody;

    let sourceItems = items;
    let commentHistory = [];

    const company = await Company.findById(companyId).populate('baseCurrency').session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    await assertLineUnitsValid(sourceItems, { companyId, session });

    // Source PO/GRPO lines are carried, so a later Item Master deactivation does not block them.
    const { activateVendorBranch, activateItemWarehouse } = billBody;
    delete billBody.activateVendorBranch;
    delete billBody.activateItemWarehouse;
    await preparePurchaseDocumentSave({
      vendorId: vendor,
      branchId,
      warehouseId,
      items: sourceItems,
      carriedItemIds: await getSourceItemIds({ purchaseOrders, grpoIds, companyId, session }),
      companyId,
      userId,
      session,
      activateVendorBranch,
      activateItemWarehouse,
      documentLabel: 'bill',
    });

    if (isSplit) {
      let branchArray = [billBody.branchId];
      const getBranchConfig = await CompanySettings.findOne({ companyId }).select('branchConfig');
      const branchConfig = getBranchConfig?.branchConfig || {};

      // Use branchConfig only if splitConfig is true, otherwise use body values
      let splitBranchId = branchConfig?.splitConfig === true ? branchConfig?.branchId : billBody.branchId;

      if (splitBranchId) {
        branchArray.push(splitBranchId.toString());
      }

      const customer = await Customer.findOne(
        { _id: new mongoose.Types.ObjectId(vendor) },
        { branch: 1 }, // only get the branches field
      )
        .lean()
        .session(session);

      // Extract branchIds from existing customer branches
      const existingBranchIds = (customer?.branch || []).map(b => b.branchId.toString());

      // Identify which branchIds are missing
      const missingBranchIds = branchArray.filter(id => !existingBranchIds.includes(id.toString()));

      // If any branchId is missing, call defaultBranchEntry
      if (missingBranchIds.length > 0) {
        await multipleDefaultBranchEntry(vendor, missingBranchIds, session);
      }
    } else {
      //give msg if brach do not exist in mention customerid
      const customer = await Customer.findOne({
        _id: new mongoose.Types.ObjectId(vendor),
        'branch.branchId': branchId,
      }).session(session);

      if (customer == null || customer == undefined) {
        await defaultBranchEntry(vendor, branchId, session);
      }
    }

    let shippingAddressId = null;
    if (isSplit) {
      const getBranchConfig = await CompanySettings.findOne({ companyId }).select('branchConfig').session(session);

      const branchConfig = getBranchConfig?.branchConfig || {};

      const splitBranchId = branchConfig?.splitConfig === true ? branchConfig?.branchId : billBody.branchId;

      const branches = [billBody.branchId, splitBranchId?.toString()];
      const totals = billBody?.items?.length > 0 ? [billBody.total, billBody.split?.total] : [billBody.split?.total];

      const branchIds = billBody?.items?.length > 0 ? branches : [splitBranchId?.toString()];

      for (let i = 0; i < branchIds.length; i++) {
        const branchId = branchIds[i];
        const amount = totals[i];

        shippingAddressId = await validateVendorForModule({
          vendorId: billBody?.vendor,
          branchId,
          companyId,
          totalAmount: amount,
          previousTotal: 0,
          moduleName: MODULE_NAMES.BILL,
          session,
          addressId: billBody.addressId,
          skipOverdueCheck: false,
          customerId: billBody?.customer,
          models: { Customer, Branch },
        });
      }
    } else {
      shippingAddressId = await validateVendorForModule({
        vendorId: billBody?.vendor,
        branchId,
        companyId,
        totalAmount: total,
        previousTotal: 0,
        moduleName: MODULE_NAMES.BILL,
        session,
        addressId: billBody.addressId,
        skipOverdueCheck: false,
        customerId: billBody?.customer,
        models: { Customer, Branch },
      });
    }

    if (purchaseOrders?.length > 0 && !grpoId) {
      const purchaseOrderIds = purchaseOrders.map(order => new mongoose.Types.ObjectId(order.purchaseOrderId));
      const itemIds = sourceItems.map(item => new mongoose.Types.ObjectId(item.itemId));

      const existingGrpo = await GrpoOrder.findOne({
        purchaseOrders: {
          $elemMatch: {
            purchaseOrderId: { $in: purchaseOrderIds },
          },
        },
        status: { $ne: GRPO_STATUSES.CANCELLED },
      })
        .select('_id grpoOrderId purchaseOrders')
        .session(session);

      if (existingGrpo) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Bill cannot be created directly from Purchase Order because GrpoOrder already exists for one or more selected Purchase Orders',
        );
      }

      await isFullyConverted(billBody.items || [], session);

      //end validation
      sourceId = purchaseOrderIds;
      sourceType = 'PO';

      const purchaseOrdersStatus = await PurchaseOrder.find({
        _id: { $in: purchaseOrderIds },
      }).session(session);

      if (purchaseOrdersStatus.length !== purchaseOrderIds.length) {
        throw new ApiError(httpStatus.NOT_FOUND, 'One or more Purchase Orders not found');
      }
      // Add commentHistory entry for bill created from PO
      purchaseOrdersStatus.forEach(order => {
        commentHistory.push({
          message: `Bill is created from Purchase Order: ${order.purchaseOrderId || order._id}`,
          addedBy: userId,
          referenceType: 'PurchaseOrder',
          referenceId: order._id,
          createdAt: new Date(),
        });
      });
    }

    if (grpoIds?.length > 0) {
      sourceType = 'GRPO';
      sourceId = grpoIds.map(g => new mongoose.Types.ObjectId(g.grpoId));

      const grpoObjectIds = grpoIds.map(g => new mongoose.Types.ObjectId(g.grpoId));

      const grpoOrders = await GrpoOrder.find({
        _id: { $in: grpoObjectIds },
        status: { $ne: GRPO_STATUSES.CANCELLED },
      }).session(session);

      if (grpoOrders.length !== grpoObjectIds.length) {
        throw new ApiError(httpStatus.NOT_FOUND, 'One or more GRPOs not found');
      }

      const billIds = grpoOrders.flatMap(grpo => grpo.convertedTo?.filter(c => c.type === 'BILL').map(c => c.documentId) || []);
      const activeBills = await Bill.find({
        _id: { $in: billIds },
        status: { $ne: BILL_STATUSES.CANCELLED },
        isSplit: false,
      }).select('_id');

      if (activeBills.length > 0) {
        const activeBillIds = new Set(activeBills.map(b => b._id.toString()));

        const alreadyBilledGRPO = grpoOrders.find(grpo =>
          grpo.convertedTo?.some(c => c.type === 'BILL' && activeBillIds.has(c.documentId.toString())),
        );

        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `GRPO ${alreadyBilledGRPO?.grpoOrderId ?? alreadyBilledGRPO?._id} is already fully billed`,
        );
      }

      const invalidStatusGRPO = grpoOrders.find(grpo => !GRPO_CONVERSION_ALLOWED_STATUSES.includes(grpo.status));

      if (invalidStatusGRPO) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `GRPO ${invalidStatusGRPO.grpoOrderId || invalidStatusGRPO._id} cannot be converted to Bill in ${
            invalidStatusGRPO.status
          } status. Allowed statuses: ${GRPO_CONVERSION_ALLOWED_STATUSES.join(', ')}`,
        );
      }

      for (const grpo of grpoOrders) {
        commentHistory.push({
          message: `Bill is created from GRPO: ${grpo.grpoOrderId || grpo._id}`,
          addedBy: userId,
          referenceType: 'GRPO',
          referenceId: grpo._id,
          createdAt: new Date(),
        });
      }
    }

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: companyId,
    });

    //add default warehouse entry
    if (billBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: billBody.items,
          warehouseId: warehouseId,
          branchId: billBody.branchId,
          divisionId: billBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }

    // Fetch latest inventory config for BILL module
    const inventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.BILL, session);
    if (billBody.customer) {
      // For a customer bill the stock effect comes only from isInventoryEnabled, not from the module config.
      inventoryConfig.stockAddEnabled = Boolean(isInventoryEnabled);
    } else if (isInventoryEnabled) {
      inventoryConfig.stockAddEnabled = true;
    }

    let currency;
    let exchangeRate;
    let decimalPlaces;

    if (grpoIds?.length > 0) {
      const sourceGrpo = await GrpoOrder.findById(grpoIds[0].grpoId)
        .select('currency exchangeRate decimalPlaces')
        .session(session);
      if (sourceGrpo?.currency) {
        currency = sourceGrpo.currency;
        exchangeRate = sourceGrpo.exchangeRate ?? 1;
        decimalPlaces = sourceGrpo.decimalPlaces ?? null;
      }
    } else if (purchaseOrders?.length > 0) {
      const sourcePo = await PurchaseOrder.findById(purchaseOrders[0].purchaseOrderId)
        .select('currency exchangeRate decimalPlaces')
        .session(session);
      if (sourcePo?.currency) {
        currency = sourcePo.currency;
        exchangeRate = sourcePo.exchangeRate ?? 1;
        decimalPlaces = sourcePo.decimalPlaces ?? null;
      }
    }

    if (!currency) {
      ({ currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
        companyId,
        vendorId: vendor,
      }));
    }

    // await generateUniqueId(Bill, companyId, MODULE_NAMES.BILL, 'billId', 'BILL', session);

    let ids = '';
    let shouldCreateMainBill = true;

    if (isSplit) {
      // Check if all items are moved to split (100% split)
      const totalMainItems = sourceItems.length;
      const totalSplitItems = billBody.split?.items?.length || 0;

      // If no main items but split items exist, don't create main bill
      if (totalMainItems === 0 && totalSplitItems > 0) {
        shouldCreateMainBill = false;
      }

      if (shouldCreateMainBill) {
        ids = await generateMultipleUniqueIdsForModules(
          Bill,
          companyId,
          [
            {
              moduleName: MODULE_NAMES.BILL,
              idField: 'billId',
              defaultPrefix: 'BILL',
              count: 1,
              resultKey: 'mainBillId',
              providedId: billBody.billId,
            },
            {
              moduleName: MODULE_NAMES.SPLIT_BILL,
              idField: 'billId',
              defaultPrefix: 'SBILL',
              count: 1,
              resultKey: 'splitBillId',
              providedId: null,
            },
          ],
          session,
        );
      } else {
        ids = await generateMultipleUniqueIdsForModules(
          Bill,
          companyId,
          [
            {
              moduleName: MODULE_NAMES.SPLIT_BILL,
              idField: 'billId',
              defaultPrefix: 'SBILL',
              count: 1,
              resultKey: 'splitBillId',
              providedId: null,
            },
          ],
          session,
        );
      }
    } else {
      billBody.billId = await generateUniqueId(Bill, companyId, MODULE_NAMES.BILL, 'billId', 'BILL', session, billBody.billId);
    }

    let finalItems = [];

    if (isSplit) {
      if (billBody?.split?.splitWiseType == 'Split By Qty') {
        const rootItems = items;
        const splitItems = billBody.split?.items || [];

        const mergedMap = new Map();

        for (const item of rootItems) {
          const key = item.itemId.toString();

          if (mergedMap.has(key)) {
            const existingItem = mergedMap.get(key);

            mergedMap.set(key, {
              ...existingItem,
              quantity: (existingItem.quantity || 0) + (item.quantity || 0),
            });
          } else {
            mergedMap.set(key, { ...item });
          }
        }

        for (const splitItem of splitItems) {
          if (mergedMap.has(splitItem.itemId)) {
            const merged = mergedMap.get(splitItem.itemId);

            merged.quantity += splitItem.quantity;
            merged.amount = (parseFloat(merged.amount) + parseFloat(splitItem.amount)).toFixed(2);

            mergedMap.set(splitItem.itemId, merged);
          } else {
            mergedMap.set(splitItem.itemId, { ...splitItem });
          }
        }

        finalItems = Array.from(mergedMap.values());
      }
      if (billBody?.split?.splitWiseType == 'Split By Price') {
        const rootItems = items;
        const splitItems = billBody.split?.items || [];
        const mergedMap = new Map();
        for (const item of rootItems) {
          const key = item.itemId.toString();
          if (mergedMap.has(key)) {
            const existingItem = mergedMap.get(key);

            mergedMap.set(key, {
              ...existingItem,
              rate: (existingItem.rate || 0) + (item.rate || 0),
            });
          } else {
            mergedMap.set(key, { ...item });
          }
        }

        for (const splitItem of splitItems) {
          const key = splitItem.itemId.toString();

          if (mergedMap.has(key)) {
            const merged = mergedMap.get(key);

            merged.rate = parseFloat(merged.rate || 0) + parseFloat(splitItem.rate || 0);

            merged.amount = (parseFloat(merged.amount || 0) + parseFloat(splitItem.amount || 0)).toFixed(2);

            mergedMap.set(key, merged);
          } else {
            mergedMap.set(key, { ...splitItem });
          }
        }

        finalItems = Array.from(mergedMap.values());
      }
    } else {
      finalItems = items;
    }

    // Fetch stock details for all requested items
    const itemIds = finalItems.map(item => item.itemId);
    let bill = null;

    if (commentHistory.length === 0) {
      const currencyDoc = await getCurrency(companyId, currency);
      commentHistory.push({
        message: `Bill created for ${currencyDoc?.symbol || '₹'}${total || 0}`,
        addedBy: userId,
        referenceType: 'BILL',
        createdAt: new Date(),
      });
    }

    if (billBody.items.length > 0 && shouldCreateMainBill) {
      const billData = {
        ...billBody,
        currency,
        exchangeRate: billBody.exchangeRate ?? 1,
        decimalPlaces,
        attachments: allAttachments,
        authorizedSignature: company?.authorizedSignature,
        items: sourceItems,
        balanceAmount: billBody.total,
        addedBy: userId,
        updatedBy: userId,
        inventoryConfig, // Store the latest config
        isSplit: false,
        commentHistory,
        companyGstin: company?.gstNumber,
        companyLogo: company?.companyLogo,
      };

      if (isSplit) {
        billData.billId = ids.mainBillId;
      }
      [bill] = await Bill.create([billData], { session });
    }

    //create split invoice
    let splitBranchId = '';
    let splitTotal = 0;
    let splitBill = {};

    if (isSplit) {
      const {
        split,
        additionalCharges,
        billDate,
        dueDate,
        paymentTermsId,
        termsAndConditions,
        customerNotes,
        billFile,
        isSplit,
        grpoId,
        grpoNo,
        grpoIds,
      } = billBody;
      const getBranchConfig = await CompanySettings.findOne({ companyId }).select('branchConfig').session(session);
      const branchConfig = getBranchConfig?.branchConfig || {};

      // Use branchConfig only if splitConfig is true, otherwise use body values
      if (branchConfig?.splitConfig === true) {
        splitBranchId = branchConfig?.branchId || null;
      } else {
        // Use body values when splitConfig is false
        splitBranchId = billBody.branchId || null;
      }

      // Determine warehouseId and divisionId based on splitConfig
      let splitWarehouseId, splitDivisionId;
      if (branchConfig?.splitConfig === true) {
        splitWarehouseId = branchConfig?.warehouseId || null;
        splitDivisionId = branchConfig?.divisionId || null;
      } else {
        // Use body values when splitConfig is false
        splitWarehouseId = billBody.warehouseId || null;
        splitDivisionId = billBody.divisionId || null;
      }
      splitTotal = split.total;

      let splitBillObj = {};
      splitBillObj.items = split.items;
      splitBillObj.subTotal = split.total;
      splitBillObj.sgst = split.sgst;
      splitBillObj.cgst = split.cgst;
      splitBillObj.igst = split.igst;
      splitBillObj.totalTax = split.totalTax;
      splitBillObj.total = split.total;
      splitBillObj.branchId = splitBranchId;
      splitBillObj.warehouseId = splitWarehouseId;
      splitBillObj.divisionId = splitDivisionId;
      splitBillObj.additionalCharges = [];
      splitBillObj.companyId = companyId;
      splitBillObj.vendor = vendor;
      splitBillObj.currency = currency;
      splitBillObj.exchangeRate = billBody.exchangeRate ?? 1;
      splitBillObj.decimalPlaces = decimalPlaces;
      splitBillObj.billDate = billDate;
      splitBillObj.dueDate = dueDate;
      splitBillObj.paymentTermsId = paymentTermsId;
      splitBillObj.customerNotes = customerNotes;
      splitBillObj.termsAndConditions = termsAndConditions;
      splitBillObj.isSplit = isSplit;
      splitBillObj.splitWiseType = split.splitWiseType;
      splitBillObj.status = BILL_STATUSES.DRAFT;
      splitBillObj.attachments = allAttachments;
      splitBillObj.balanceAmount = split.total;
      splitBillObj.addedBy = userId;
      splitBillObj.updatedBy = userId;
      splitBillObj.inventoryConfig = inventoryConfig;
      splitBillObj.billId = ids.splitBillId;
      if (grpoId) {
        splitBillObj.grpoId = grpoId;
        splitBillObj.grpoNo = grpoNo;
      }
      splitBillObj.grpoIds = grpoIds;
      splitBillObj.splitWarehouseId = billBody?.warehouseId;
      splitBillObj.splitBillId = bill?._id || null;
      splitBillObj.addressId = shippingAddressId;
      splitBillObj.authorizedSignature = company?.authorizedSignature;
      splitBillObj.companyGstin = company?.gstNumber;
      splitBillObj.companyLogo = company?.companyLogo;
      splitBillObj.roundOffAmount = split?.roundOffAmount;
      splitBillObj.isRoundOff = split?.isRoundOff;

      //create split bill
      [splitBill] = await Bill.create([splitBillObj], { session });

      if (bill) {
        await Bill.updateOne(
          { _id: bill._id },
          { $set: { splitBillId: splitBill._id, splitWarehouseId: warehouseId } },
          { session },
        );
      }
    }

    if (inventoryConfig.stockAddEnabled) {
      if (isSplit == false || !isSplit) {
        if (bill && !bill?.splitBillId) {
          const claimBillLine = createLineClaimer(bill.items);
          for (let i of finalItems) {
            // Calculate the final purchase price after discount
            let finalPurchasePrice = i.rate;
            if (i.discountConfig) {
              let discountAmount = 0;
              if (i.discountConfig.discountType === 'PERCENTAGE' && i.discountConfig.discountValue > 0) {
                discountAmount = (i.rate * i.discountConfig.discountValue) / 100;
              } else if (i.discountConfig.discountType === 'AMOUNT' && i.discountConfig.discountValue > 0) {
                // For AMOUNT type, divide by quantity to get per-unit discount
                discountAmount = i.discountConfig.discountValue / i.quantity;
              }
              finalPurchasePrice = i.rate - discountAmount;
            }

            // Store batch cost in base at document exchangeRate so sale COGS matches inventory and cost stays fixed at receipt.
            finalPurchasePrice = Math.round(finalPurchasePrice * (Number(bill?.exchangeRate) || 1) * 100) / 100;

            // Find the corresponding item in the bill and add batch
            const billItem = claimBillLine(i);

            //add warehouseItem Batch
            const warehouseStockObj = {
              action: 'addStock',
              stockData: {
                itemId: i.itemId,
                companyId: companyId,
                divisionId: bill?.divisionId,
                branchId: bill?.branchId,
                warehouseId,
                quantity: i.quantity,
                itemUnitId: i.itemUnitId,
                purchasePrice: finalPurchasePrice,
                vendorBatchNo: i?.vendorBatchNo,
                vendorBatchExpiry: i?.vendorBatchExpiry,
                sourceType: MODULE_NAMES.BILL,
                sourceId: bill?._id,
                addedBy: userId,
              },
              session,
            };
            const batchSummary = await handleWarehouseStock(warehouseStockObj);
            if (batchSummary && !batchSummary?.skipped) {
              const batchToAdd = {
                batchNo: batchSummary.batchNo,
                quantity: batchSummary.quantity,
                purchasePrice: batchSummary.purchasePrice,
                warehouseId: bill.warehouseId,
                itemBatchId: batchSummary?._id,
              };
              if (billItem) {
                if (!billItem.batches) billItem.batches = [];
                billItem.batches.push(batchToAdd);
              }
            }
          }

          await checkCompanyStockLevels({
            itemIds: finalItems.map(i => i.itemId),
            companyId,
            docType: MODULE_NAMES.BILL,
            docId: bill._id,
            docNo: bill.billId,
            userId,
            session,
          });

          // Update the bill with the batches
          await Bill.updateOne({ _id: bill._id }, { $set: { items: bill.items } }, { session });
        }
      }

      if (isSplit == true) {
        if (billBody?.split?.splitWiseType == 'Split By Qty') {
          if (bill) {
            const claimBillLine = createLineClaimer(bill.items);
            for (let i of finalItems) {
              // Calculate the final purchase price after discount
              let finalPurchasePrice = i.rate;
              if (i.discountConfig) {
                let discountAmount = 0;
                if (i.discountConfig.discountType === 'PERCENTAGE' && i.discountConfig.discountValue > 0) {
                  discountAmount = (i.rate * i.discountConfig.discountValue) / 100;
                } else if (i.discountConfig.discountType === 'AMOUNT' && i.discountConfig.discountValue > 0) {
                  // For AMOUNT type, divide by quantity to get per-unit discount
                  discountAmount = i.discountConfig.discountValue / i.quantity;
                }
                finalPurchasePrice = i.rate - discountAmount;
              }

              // Store batch cost in base at document exchangeRate so sale COGS matches inventory and cost stays fixed at receipt.
              finalPurchasePrice = Math.round(finalPurchasePrice * (Number(bill?.exchangeRate) || 1) * 100) / 100;

              // Find the corresponding item in the bill and add batch
              const billItem = claimBillLine(i);

              //add warehouseItem Batch
              const warehouseStockObj = {
                action: 'addStock',
                stockData: {
                  itemId: i.itemId,
                  companyId: companyId,
                  divisionId: bill?.divisionId,
                  branchId: bill?.branchId,
                  warehouseId,
                  quantity: i.quantity,
                  itemUnitId: i.itemUnitId,
                  purchasePrice: finalPurchasePrice,
                  vendorBatchNo: i?.vendorBatchNo,
                  vendorBatchExpiry: i?.vendorBatchExpiry,
                  sourceType: MODULE_NAMES.BILL,
                  sourceId: bill?._id,
                  addedBy: userId,
                },
                session,
              };
              const batchSummary = await handleWarehouseStock(warehouseStockObj);
              if (batchSummary && !batchSummary?.skipped) {
                const batchToAdd = {
                  batchNo: batchSummary.batchNo,
                  quantity: batchSummary.quantity,
                  purchasePrice: batchSummary.purchasePrice,
                  warehouseId: bill.warehouseId,
                  itemBatchId: batchSummary?._id,
                };
                if (billItem) {
                  if (!billItem.batches) billItem.batches = [];
                  billItem.batches.push(batchToAdd);
                }
              }
            }

            await checkCompanyStockLevels({
              itemIds: finalItems.map(i => i.itemId),
              companyId,
              docType: MODULE_NAMES.BILL,
              docId: bill._id,
              docNo: bill.billId,
              userId,
              session,
            });

            // Update the bill with the batches
            await Bill.updateOne({ _id: bill._id }, { $set: { items: bill.items } }, { session });
          }

          const isItemEmpty = !billBody?.items || billBody.items.length === 0;
          const isSplitBillPresent = !!splitBill;
          const condition = isItemEmpty && !bill && isSplitBillPresent;
          if (condition) {
            const claimSplitBillLine = createLineClaimer(splitBill.items);
            for (let i of splitBill?.items) {
              // Calculate the final purchase price after discount
              let finalPurchasePrice = i.rate;
              if (i.discountConfig) {
                let discountAmount = 0;
                if (i.discountConfig.discountType === 'PERCENTAGE' && i.discountConfig.discountValue > 0) {
                  discountAmount = (i.rate * i.discountConfig.discountValue) / 100;
                } else if (i.discountConfig.discountType === 'AMOUNT' && i.discountConfig.discountValue > 0) {
                  // For AMOUNT type, divide by quantity to get per-unit discount
                  discountAmount = i.discountConfig.discountValue / i.quantity;
                }
                finalPurchasePrice = i.rate - discountAmount;
              }

              // Store batch cost in base at document exchangeRate so sale COGS matches inventory and cost stays fixed at receipt.
              finalPurchasePrice = Math.round(finalPurchasePrice * (Number(bill?.exchangeRate) || 1) * 100) / 100;

              // Find the corresponding item in the bill and add batch
              const billItem = claimSplitBillLine(i);

              //add warehouseItem Batch
              const warehouseStockObj = {
                action: 'addStock',
                stockData: {
                  itemId: i.itemId,
                  companyId: companyId,
                  divisionId: splitBill?.divisionId,
                  branchId: splitBill?.branchId,
                  warehouseId: splitBill?.warehouseId,
                  quantity: i.quantity,
                  itemUnitId: i.itemUnitId,
                  purchasePrice: finalPurchasePrice,
                  vendorBatchNo: i?.vendorBatchNo,
                  vendorBatchExpiry: i?.vendorBatchExpiry,
                  sourceType: MODULE_NAMES.SPLIT_BILL,
                  sourceId: splitBill?._id,
                  addedBy: userId,
                },
                session,
              };
              const batchSummary = await handleWarehouseStock(warehouseStockObj);

              if (batchSummary && !batchSummary?.skipped) {
                const batchToAdd = {
                  batchNo: batchSummary.batchNo,
                  quantity: batchSummary.quantity,
                  purchasePrice: batchSummary.purchasePrice,
                  warehouseId: splitBill.warehouseId,
                  itemBatchId: batchSummary?._id,
                };
                if (billItem) {
                  if (!billItem.batches) billItem.batches = [];
                  billItem.batches.push(batchToAdd);
                }
              }
            }

            await checkCompanyStockLevels({
              itemIds: splitBill.items.map(i => i.itemId),
              companyId,
              docType: MODULE_NAMES.SPLIT_BILL,
              docId: splitBill._id,
              docNo: splitBill.billId,
              userId,
              session,
            });

            // Update the bill with the batches
            await Bill.updateOne({ _id: splitBill._id }, { $set: { items: splitBill.items } }, { session });
          }
        }

        if (billBody?.split?.splitWiseType == 'Split By Price') {
          if (bill) {
            const claimBillLine = createLineClaimer(bill.items);
            for (let i of finalItems) {
              // Calculate the final purchase price after discount
              let finalPurchasePrice = i.rate;
              if (i.discountConfig) {
                let discountAmount = 0;
                if (i.discountConfig.discountType === 'PERCENTAGE' && i.discountConfig.discountValue > 0) {
                  discountAmount = (i.rate * i.discountConfig.discountValue) / 100;
                } else if (i.discountConfig.discountType === 'AMOUNT' && i.discountConfig.discountValue > 0) {
                  // For AMOUNT type, divide by quantity to get per-unit discount
                  discountAmount = i.discountConfig.discountValue / i.quantity;
                }
                finalPurchasePrice = i.rate - discountAmount;
              }

              // Store batch cost in base at document exchangeRate so sale COGS matches inventory and cost stays fixed at receipt.
              finalPurchasePrice = Math.round(finalPurchasePrice * (Number(bill?.exchangeRate) || 1) * 100) / 100;

              // Find the corresponding item in the bill and add batch
              const billItem = claimBillLine(i);

              //add warehouseItem Batch
              const warehouseStockObj = {
                action: 'addStock',
                stockData: {
                  itemId: i.itemId,
                  companyId: bill?.companyId,
                  divisionId: bill?.divisionId,
                  branchId: bill?.branchId,
                  warehouseId,
                  quantity: i.quantity,
                  itemUnitId: i.itemUnitId,
                  purchasePrice: finalPurchasePrice,
                  vendorBatchNo: i?.vendorBatchNo,
                  vendorBatchExpiry: i?.vendorBatchExpiry,
                  sourceType: MODULE_NAMES.BILL,
                  sourceId: bill?._id,
                  addedBy: userId,
                },
                session,
              };
              const batchSummary = await handleWarehouseStock(warehouseStockObj);

              if (batchSummary && !batchSummary?.skipped) {
                const batchToAdd = {
                  batchNo: batchSummary.batchNo,
                  quantity: batchSummary.quantity,
                  purchasePrice: batchSummary.purchasePrice,
                  warehouseId: bill.warehouseId,
                  itemBatchId: batchSummary?._id,
                };
                if (billItem) {
                  if (!billItem.batches) billItem.batches = [];
                  billItem.batches.push(batchToAdd);
                }
              }
            }

            await checkCompanyStockLevels({
              itemIds: finalItems.map(i => i.itemId),
              companyId: bill?.companyId,
              docType: MODULE_NAMES.BILL,
              docId: bill._id,
              docNo: bill.billId,
              userId,
              session,
            });

            // Update the bill with the batches
            await Bill.updateOne({ _id: bill._id }, { $set: { items: bill.items } }, { session });
          }
        }
      }
    }

    if (isSplit) {
      const branches = [billBody.branchId, splitBranchId.toString()];
      const totals = shouldCreateMainBill ? [total, splitTotal] : [splitTotal];
      const branchIds = shouldCreateMainBill ? branches : [splitBranchId.toString()];

      for (let i = 0; i < branchIds.length; i++) {
        const branchId = branchIds[i];
        const amount = totals[i];

        await updateBranchCurrentBalance({
          customerId: vendor,
          branchId,
          amount: amount,
          session,
        });
      }
    } else {
      await updateBranchCurrentBalance({
        customerId: vendor,
        branchId,
        amount: total,
        session,
      });
    }

    // Update PO or GRPO
    if (purchaseOrders?.length > 0 && shouldCreateMainBill) {
      for (const po of purchaseOrders) {
        // Re-fetch the most recent PO record from the database
        const purchaseOrderDoc = await PurchaseOrder.findById(po.purchaseOrderId).session(session);

        // Ensure convertedTo exists and append billing info
        purchaseOrderDoc.convertedTo = purchaseOrderDoc.convertedTo || [];
        purchaseOrderDoc.convertedTo.push({
          type: 'BILL',
          documentId: bill._id,
          documentNo: bill.billId,
          convertedAt: new Date(),
        });
        purchaseOrderDoc.commentHistory.push({
          message: `Purchase Order converted to Bill ${bill.billId}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'BILL',
          referenceId: bill._id || bill.id || bill.billId,
        });

        // Save updated document in session
        await purchaseOrderDoc.save({ session });
      }
    }

    if (Array.isArray(grpoIds) && grpoIds.length) {
      for (const i of grpoIds) {
        const grpoOrder = await GrpoOrder.findById(i.grpoId).session(session);

        if (itemIds.length > 0 && shouldCreateMainBill && bill) {
          grpoOrder.convertedTo.push({
            type: 'BILL',
            documentId: bill._id,
            documentNo: bill.billId,
            convertedAt: new Date(),
          });
        }

        grpoOrder.commentHistory = grpoOrder.commentHistory || [];
        if (bill) {
          grpoOrder.commentHistory.push({
            message: `GRPO converted to Bill ${bill.billId}`,
            addedBy: userId,
            createdAt: new Date(),
            referenceType: 'BILL',
            referenceId: bill._id,
          });
        }

        grpoOrder.status = GRPO_STATUSES.CONVERTED;
        await grpoOrder.save({ session });
      }
    }

    if (bill?._id) {
      await syncBillJournal(companyId, bill, userId, session);
    }
    if (splitBill?._id) {
      await syncBillJournal(companyId, splitBill, userId, session);
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    const created = items.length > 0 ? bill : splitBill;

    if (bill) {
      notifyModuleDocumentIfNonDraft({
        companyId,
        moduleName: MODULE_NAMES.BILL,
        document: bill,
        initialStatus: BILL_STATUSES.DRAFT,
      });
    }

    const { tryAutoPayForBill } = require('../../../services/companyAutoPay.service');
    const createdCandidates = [bill, splitBill].filter(Boolean);
    for (const createdBill of createdCandidates) {
      if (createdBill.status === BILL_STATUSES.OPEN) {
        await tryAutoPayForBill({ billId: createdBill._id, companyId, userId });
      }
    }

    return enrichDocumentCurrency(companyId, created.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

// Helper function to generate stock movement notes

const getStockMovementNotes = (grpoOrderId, purchaseOrderId) => {
  if (grpoOrderId) return `Bill created from GRPO ${grpoOrderId}`;
  if (purchaseOrderId) return `Bill created from PO ${purchaseOrderId}`;
  return 'Direct bill created';
};

const queryBills = async (filter, options) => {
  const { Customer, Item, Branch, Division, Warehouse, PaymentTerm, ItemUnit } = getBooksCrmModels();
  const { Bill, PaymentMade } = getBooksModels();
  const { User, Company } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const conditions = { companyId };

  if (filter?.isSplit == undefined) {
    conditions.isSplit = false;
  }

  if (filter?.isSplit) {
    conditions.isSplit = true;
  }

  // Status filter
  if (filter?.status?.split(',').length > 0) {
    conditions.status = { $in: filter.status.split(',') };
  }

  if (filter.addedBy) {
    const addedByIds = filter.addedBy
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
    if (addedByIds.length > 0) conditions.addedBy = { $in: addedByIds };
  }

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'billDate' });
  if (branchDivisionCond) {
    Object.assign(conditions, branchDivisionCond);
  }

  // Search filter
  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());
    const vendors = await Customer.find(
      {
        companyId,
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    );

    const vendorIds = vendors.map(vendor => vendor._id);
    conditions.$or = [{ grpoNo: searchRegex }, { vendor: { $in: vendorIds } }, { billId: searchRegex }];
  }

  if (filter?.customerId) {
    const customerIds = String(filter.customerId)
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));

    if (customerIds.length > 0) {
      conditions.vendor = { $in: customerIds };
    }
  }

  // addressType + Country/State/City filters: billTo -> vendor billing address; else addressId of the drop-ship customer's shipping addresses (when `customer` is set) or the company's addresses
  const addressCondition = await getPurchaseAddressCondition(Customer, Company, companyId, filter, 'vendor');
  if (addressCondition) {
    (conditions.$and ||= []).push(addressCondition);
  }

  if (options?.countOnly) {
    return { results: [], totalResults: await Bill.countDocuments(conditions) };
  }

  // Get the paginated results and aggregated totals
  const result = await Bill.paginateWithTotal(conditions, options);

  const billIds = result.results.map(bill => bill._id);

  const paymentQuery = {
    'bills.billId': { $in: billIds },
    status: { $ne: PAYMENT_STATUS.CANCELLED },
    companyId,
  };

  if (filter?.isSplit === undefined) {
    paymentQuery.isSplit = false;
  }
  const paymentsForBills = await PaymentMade.find(paymentQuery).select('bills paymentMadeId paymentDate status paymentMade');

  const paymentsByBill = paymentsForBills.reduce((acc, payment) => {
    (payment.bills || []).forEach(b => {
      const key = b.billId?.toString();
      if (key) (acc[key] ||= []).push(payment);
    });
    return acc;
  }, {});

  // Unique vendor and item IDs
  const vendorIds = [...new Set(result.results.map(bill => bill.vendor?.toString()).filter(Boolean))];
  const branchIds = [...new Set(result.results.map(i => i.branchId))];
  const warehouseIds = [...new Set(result.results.map(i => i.warehouseId))];
  const divisionIds = [...new Set(result.results.map(i => i.divisionId))];
  const itemIds = [...new Set(result.results.flatMap(bill => bill.items?.map(item => item.itemId?.toString())).filter(Boolean))];
  const addedByIds = [...new Set(result.results.map(i => i.addedBy))];
  const updatedByIds = [...new Set(result.results.map(i => toUpdatedByUserIdString(i.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];
  const paymentTermIds = [...new Set(result.results.map(bill => bill.paymentTermsId?.toString()).filter(Boolean))];

  // Fetch related data
  const [vendors, items, branch, warehouse, division, users, paymentTerms] = await Promise.all([
    Customer.find({ _id: { $in: vendorIds } })
      .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails')
      .lean(),
    Item.find({ _id: { $in: itemIds } })
      .select('itemName')
      .lean(),
    await Branch.find({
      _id: { $in: branchIds },
    })
      .select('name _id')
      .lean(),
    await Warehouse.find({
      _id: { $in: warehouseIds },
    })
      .select('name _id')
      .lean(),
    await Division.find({
      _id: { $in: divisionIds },
    })
      .select('name _id')
      .lean(),
    User.find({ _id: { $in: userIds } })
      .select('firstName lastName')
      .lean(),
    PaymentTerm.find({ _id: { $in: paymentTermIds } }).lean(),
  ]);

  // Build lookup maps
  const vendorMap = vendors.reduce((acc, vendor) => {
    acc[vendor._id.toString()] = vendor;
    return acc;
  }, {});

  const branchMap = branch.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const divisionMap = division.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const warehouseMap = warehouse.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const itemMap = items.reduce((acc, item) => {
    acc[item._id.toString()] = item;
    return acc;
  }, {});

  const userMap = users.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});

  const paymentTermMap = paymentTerms.reduce((acc, term) => {
    acc[term._id.toString()] = term;
    return acc;
  }, {});

  // Resolve addressId: drop-ship customer's addresses when `customer` has a value, else company address / additionalShippingAddresses
  const resolveAddress = await getPurchaseAddressResolver(Customer, Company, companyId, result.results);

  // Populate final results
  const populatedResults = await Promise.all(
    result.results.map(async bill => {
      const obj = bill.toObject();
      obj.addressIn = resolveAddress(obj);

      if (obj?.splitBillId) {
        const billDoc = await Bill.findById(obj.splitBillId).select('billId');
        obj.splitBillNo = billDoc?.billId || '';
      }

      obj.id = obj._id;
      obj.branchId = branchMap[obj.branchId?.toString()] || null;
      obj.divisionId = divisionMap[obj.divisionId?.toString()] || null;
      obj.warehouseId = warehouseMap[obj.warehouseId?.toString()] || null;
      obj.vendor = vendorMap[obj.vendor?.toString()] || null;
      obj.paymentTermsId = paymentTermMap[obj.paymentTermsId?.toString()] || null;

      if (Array.isArray(obj.items)) {
        obj.items = obj.items.map(i => ({
          ...i,
          itemId: itemMap[i.itemId?.toString()] || null,
        }));
      }

      obj.addedBy = userMap[obj.addedBy?.toString()] || null;
      const updatedById = toUpdatedByUserIdString(obj.updatedBy);
      const updatedBy = updatedById ? userMap[updatedById] : null;
      obj.updatedBy = updatedBy || null;
      obj.payments = paymentsByBill[obj._id?.toString()] || [];

      return obj;
    }),
  );

  const populatedResultsWithCurrency = await enrichDocumentCurrency(
    String(filter.companyId),
    await attachItemSummaries(populatedResults),
  );

  return {
    ...result,
    results: populatedResultsWithCurrency,
  };
};

const queryBillsExports = async (filter, options) => {
  const result = await queryBills(filter, { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

const getBillById = async (id, companyId) => {
  const { Customer, Branch, Division, Warehouse, PaymentTerm, OpeningBalanceTransaction, ItemUnit } = getBooksCrmModels();
  const { Bill, PurchaseOrder, GrpoOrder } = getBooksModels();
  const { User, Company } = getCommonModels();
  // Get the bill (only the line unit is populated; ItemUnit lives in booksCrm, so pass the model explicitly)
  const bill = await Bill.findOne({ _id: id, companyId }).populate({ path: 'items.itemUnitId', select: 'name', model: ItemUnit });
  if (!bill) {
    throw new ApiError(httpStatus.NOT_FOUND, BILL_MESSAGES.FETCH_ONE_FAILURE);
  }

  // Get vendor data
  const vendor = await Customer.findById(bill.vendor)
    .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails branch isVendorDirectTax')
    .lean();

  let po = [];
  if (bill?.purchaseOrders?.length > 0) {
    for (let i of bill.purchaseOrders) {
      const data = await PurchaseOrder.findById(i.purchaseOrderId).select('status total date purchaseOrderId').lean();
      po.push({ ...data, purchaseOrderId: i.purchaseOrderId, purchaseOrderNo: i.purchaseOrderNo });
    }
  }

  if (bill.grpoId) {
    bill.grpoId = await GrpoOrder.findById(bill.grpoId).select('status date dueDate total grpoOrderId').lean();
  }

  let grpoIds = [];
  if (bill?.grpoIds?.length > 0) {
    for (let i of bill.grpoIds) {
      const grpoOrders = await GrpoOrder.findById(i.grpoId).select('status date dueDate total grpoOrderId').lean();
      grpoIds.push({ ...grpoOrders, grpoId: i.grpoId, grpoNo: i.grpoNo });
    }
  }

  // --- Populate commentHistory.addedBy ---
  let commentHistoryWithUser = [];
  if (bill.commentHistory?.length) {
    const userIds = bill.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = bill.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy, // replaces addedBy with user details if found
      };
    });
  }

  const company = await Company.findById(bill.companyId);

  let shippingAddress = null;
  let customer = null;
  if (!bill.customer) {
    if (bill.addressId) {
      if (bill?.addressId?.toString() === company?.address?._id?.toString()) {
        shippingAddress = company.address;
      }
      if (!shippingAddress) {
        shippingAddress = company?.additionalShippingAddresses?.find(addr => addr._id.toString() === bill.addressId.toString());
      }
    }
  } else {
    customer = await Customer.findById(bill.customer);
    if (customer?.address?.shipping?._id.toString() === bill?.addressId?.toString()) {
      shippingAddress = customer?.address?.shipping;
    } else if (
      customer?.address?.additionalShippingAddresses?.some(address => address._id.toString() === bill?.addressId?.toString())
    ) {
      shippingAddress = customer?.address?.additionalShippingAddresses?.find(
        address => address._id.toString() === bill?.addressId?.toString(),
      );
    }
  }

  const branch = await Branch.findById(bill.branchId).select('name');
  const division = await Division.findById(bill.divisionId).select('name');
  const warehouse = await Warehouse.findById(bill.warehouseId).select('name');
  const paymentTerm = bill.paymentTermsId ? await PaymentTerm.findById(bill.paymentTermsId).lean() : null;

  const addedBy = await User.findById(bill.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(bill.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;

  // Convert bill to object and populate the data
  const billObj = bill.toObject();
  if (billObj?.splitBillId) {
    const bill = await Bill.findById(billObj.splitBillId).select('billId');
    billObj.splitBillNo = bill?.billId || '';
  }
  billObj.addedBy = addedBy;
  billObj.updatedBy = updatedBy;
  billObj.branchName = branch.name;
  billObj.divisionName = division.name;
  billObj.warehouseName = warehouse.name;
  billObj.grpoIds = grpoIds;
  // Populate vendor data
  billObj.vendor = vendor || null;
  billObj.paymentTermsId = paymentTerm || null;
  billObj.shippingAddress = shippingAddress || {};

  if (customer) {
    billObj.customerDisplayName = customer?.customerDisplayName;
  }

  billObj.commentHistory = commentHistoryWithUser;
  billObj.purchaseOrders = po;
  // Not branch-pinned: cross-branch credit application is supported, so the affordance should appear
  // whenever the vendor has an applicable credit in any branch (matching the cross-branch apply modal).
  billObj.hasAvailableCredits = !!(await OpeningBalanceTransaction.exists({
    companyId: new mongoose.Types.ObjectId(companyId),
    contactId: bill.vendor,
    contactType: CONTACT_TYPE.VENDOR,
    type: TRANSACTION_TYPE.VENDOR_CREDIT,
    remainingAmount: { $gt: 0 },
  }));
  billObj.moduleTree = await buildModuleTree(id);

  return enrichDocumentCurrency(companyId, billObj);
};

const queryVendorWisePendingBills = async (filter, options) => {
  const { Bill } = getBooksModels();
  const { OpeningBalanceTransaction, Branch } = getBooksCrmModels();
  const isCreditMapping = filter?.forCreditMapping;
  delete filter.forCreditMapping;
  const allowCrossBranchMapping = !!filter?.allowCrossBranchMapping;
  delete filter.allowCrossBranchMapping;

  if (filter.branchId) {
    filter.branchId = new mongoose.Types.ObjectId(filter.branchId);
  }

  if (filter.divisionId) {
    filter.divisionId = new mongoose.Types.ObjectId(filter.divisionId);
  }

  if (filter.warehouseId) {
    filter.warehouseId = new mongoose.Types.ObjectId(filter.warehouseId);
  }

  if (filter?.isSplit == undefined) {
    filter.isSplit = false;
  }
  filter.status = [BILL_STATUSES.OPEN, BILL_STATUSES.PARTIALLY_PAID, BILL_STATUSES.PAID, BILL_STATUSES.OVERDUE];
  filter.status = filter.isAdd ? filter.status : filter.status.filter(status => status !== BILL_STATUSES.PAID);

  const paymentBranchId = filter.branchId;
  if (allowCrossBranchMapping) {
    delete filter.branchId;
  }

  options.select = 'billId billDate total status balanceAmount branchId warehouseId divisionId dueDate tax';

  if (!options.sortBy) {
    options.sortBy = 'dueDate:asc';
  }

  const bills = await Bill.paginate(filter, options);
  bills.results = await attachBranchNames(Branch, bills.results || []);

  const vendorId = filter.vendor ? new mongoose.Types.ObjectId(filter.vendor) : null;
  let openingBalanceTransactions = [];
  if (vendorId && (!filter.isAdd || filter.balanceAmount)) {
    const obTypes = isCreditMapping
      ? [TRANSACTION_TYPE.VENDOR_CREDIT, TRANSACTION_TYPE.OPENING_PAYABLE]
      : [TRANSACTION_TYPE.OPENING_PAYABLE];
    const obBranchId = allowCrossBranchMapping ? null : paymentBranchId || filter.branchId;
    const obFilter = {
      contactId: vendorId,
      contactType: 'vendor',
      type: { $in: obTypes },
      remainingAmount: { $gt: 0 },
      ...(obBranchId && { branchId: new mongoose.Types.ObjectId(obBranchId) }),
      ...(filter.companyId && { companyId: new mongoose.Types.ObjectId(filter.companyId) }),
    };
    const openingBalanceList = await OpeningBalanceTransaction.find(obFilter)
      .select('transactionNo date amount remainingAmount branchId type')
      .sort({ date: 1 })
      .lean();
    openingBalanceTransactions = await attachBranchNames(Branch, openingBalanceList || []);
  }

  return {
    ...bills,
    openingBalanceTransactions,
  };
};

const updateBillById = async (billId, updateBody, userId, uploadedFiles = []) => {
  const { Customer, Branch } = getBooksCrmModels();
  const { Bill } = getBooksModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const {
      items: newItems,
      branchId,
      vendor,
      total,
      warehouseId,
      companyId,
      isInventoryEnabled,
      ...otherUpdateBody
    } = updateBody;

    const bill = await Bill.findOne({ _id: billId, companyId }).session(session);
    if (!bill) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found');
    }
    const company = await Company.findById(bill.companyId).populate('baseCurrency').session(session);

    const oldtotal = bill.total;
    // Validate edit permissions
    validateEditPermissions(BILL_STATUS_CONFIG.EDIT_RESTRICTED_STATUSES, bill.status);

    const { activateVendorBranch, activateItemWarehouse } = otherUpdateBody;
    delete otherUpdateBody.activateVendorBranch;
    delete otherUpdateBody.activateItemWarehouse;
    await preparePurchaseDocumentSave({
      vendorId: vendor,
      branchId,
      warehouseId,
      items: newItems,
      carriedItemIds: (bill.items || []).map(item => item.itemId),
      companyId,
      userId,
      session,
      activateVendorBranch,
      activateItemWarehouse,
      documentLabel: 'bill',
    });

    //give msg if brach do not exist in mention customerid
    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(vendor),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(vendor, branchId, session);
    }

    await validateVendorForModule({
      vendorId: updateBody.vendor,
      branchId: updateBody.branchId,
      companyId,
      totalAmount: updateBody.total,
      previousTotal: oldtotal,
      moduleName: MODULE_NAMES.BILL,
      session,
      skipOverdueCheck: true,
      customerId: updateBody?.customer,
      addressId: updateBody?.addressId,
      models: { Customer, Branch },
    });

    if (vendor && String(vendor) !== String(bill.vendor)) {
      const resolved = await resolveTransactionCurrency({
        companyId: bill.companyId,
        vendorId: vendor,
      });
      otherUpdateBody.currency = resolved.currency;
      otherUpdateBody.decimalPlaces = resolved.decimalPlaces;
    }
    otherUpdateBody.exchangeRate = updateBody.exchangeRate ?? 1;

    const currencyDoc = await getCurrency(bill.companyId, otherUpdateBody.currency || bill.currency);

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: updateBody.attachments ? updateBody.attachments : [],
      existingUrls: bill.attachments ? bill.attachments : [],
      userId,
      companyId: bill.companyId,
    });

    //add default warehouse entry
    if (updateBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: updateBody.items,
          warehouseId: warehouseId,
          branchId: updateBody.branchId,
          divisionId: updateBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }

    // A customer bill keeps the stock effect chosen at creation (isInventoryEnabled is not editable).
    const isCustomerBill = Boolean(bill.customer);

    if (!isCustomerBill && bill?.inventoryConfig?.stockAddEnabled && !isInventoryEnabled) {
      for (let i of bill.items) {
        const warehouseStockObj = {
          action: 'deleteStock',
          stockData: {
            itemId: i.itemId,
            companyId: bill.companyId,
            warehouseId: bill.warehouseId,
            deductedSourceType: MODULE_NAMES.BILL,
            deductedSourceId: billId,
          },
          session,
        };
        await handleWarehouseStock(warehouseStockObj);

        i.batches = [];
      }

      await checkCompanyStockLevels({
        itemIds: bill.items.map(i => i.itemId),
        companyId: bill.companyId,
        docType: MODULE_NAMES.BILL,
        docId: billId,
        docNo: bill.billId,
        userId,
        session,
      });
    }
    // Fetch latest inventory config for BILL module
    const latestInventoryConfig = isCustomerBill
      ? bill.inventoryConfig
      : await getInventoryConfig(companyId, MODULE_NAMES.BILL, session);
    if (!isCustomerBill && isInventoryEnabled) {
      latestInventoryConfig.stockAddEnabled = true;
    }

    // Handle item changes if provided
    if (newItems && newItems.length > 0) {
      // Batches resolved per submitted line (index-aligned with newItems) when stock is synced below.
      let lineBatches = null;

      const getFinalPurchasePrice = item => {
        let finalPurchasePrice = item.rate;
        if (item.discountConfig) {
          let discountAmount = 0;
          if (item.discountConfig.discountType === 'PERCENTAGE' && item.discountConfig.discountValue > 0) {
            discountAmount = (item.rate * item.discountConfig.discountValue) / 100;
          } else if (item.discountConfig.discountType === 'AMOUNT' && item.discountConfig.discountValue > 0) {
            // For AMOUNT type, divide by quantity to get per-unit discount
            discountAmount = item.discountConfig.discountValue / item.quantity;
          }
          finalPurchasePrice = item.rate - discountAmount;
        }
        // Store batch cost in base at document exchangeRate so sale COGS matches inventory and cost stays fixed at receipt.
        return Math.round(finalPurchasePrice * (Number(otherUpdateBody?.exchangeRate) || 1) * 100) / 100;
      };

      // Each submitted line paired with the existing line of the same item + unit + price (then item + unit).
      const { matches: lineMatches, unmatchedOldLines } = pairLinesWithExisting(newItems, bill.items);

      // Process inventory updates if stock add is enabled
      if (latestInventoryConfig?.stockAddEnabled) {
        // The same item can appear on several lines (different qty/price/unit), each owning its own batch,
        // so every line adjusts its own batch regardless of order and a removed line releases only its own batch.
        const releasedBatches = unmatchedOldLines.map(line => ({ itemId: line.itemId, batches: line.batches || [] }));

        lineBatches = [];
        for (const [index, newItem] of newItems.entries()) {
          const [oldBatch, ...extraBatches] = lineMatches[index]?.batches || [];
          if (extraBatches.length) releasedBatches.push({ itemId: newItem.itemId, batches: extraBatches });
          const finalPurchasePrice = getFinalPurchasePrice(newItem);

          if (oldBatch?.itemBatchId) {
            const adjusted = await adjustStockByBatchId({
              stockData: {
                itemId: newItem.itemId,
                companyId: bill.companyId,
                warehouseId: bill.warehouseId,
                itemBatchId: oldBatch.itemBatchId,
                newQuantity: newItem.quantity,
                itemUnitId: newItem.itemUnitId,
                newPurchasePrice: finalPurchasePrice,
                vendorBatchNo: newItem?.vendorBatchNo,
                vendorBatchExpiry: newItem?.vendorBatchExpiry,
              },
              session,
            });
            lineBatches.push([
              {
                batchNo: adjusted.batchNo,
                quantity: adjusted.quantity,
                purchasePrice: adjusted.purchasePrice,
                warehouseId: bill.warehouseId,
                itemBatchId: adjusted.itemBatchId,
              },
            ]);
            continue;
          }

          const batchSummary = await handleWarehouseStock({
            action: 'addStock',
            stockData: {
              itemId: newItem.itemId,
              companyId: bill?.companyId,
              divisionId: bill?.divisionId,
              branchId: bill?.branchId,
              warehouseId: bill?.warehouseId,
              quantity: newItem.quantity,
              itemUnitId: newItem.itemUnitId,
              purchasePrice: finalPurchasePrice,
              vendorBatchNo: newItem?.vendorBatchNo,
              vendorBatchExpiry: newItem?.vendorBatchExpiry,
              sourceType: MODULE_NAMES.BILL,
              sourceId: billId,
              addedBy: userId,
            },
            session,
          });

          lineBatches.push(
            batchSummary && !batchSummary?.skipped
              ? [
                  {
                    batchNo: batchSummary.batchNo,
                    quantity: batchSummary.quantity,
                    purchasePrice: batchSummary.purchasePrice,
                    warehouseId: bill.warehouseId,
                    itemBatchId: batchSummary?._id,
                  },
                ]
              : [],
          );
        }

        // Batches left in the pool belong to lines that were removed - release their stock.
        const touchedItemIds = new Set(newItems.map(i => i.itemId.toString()));
        for (const { itemId: releasedItemId, batches: releasedList } of releasedBatches) {
          for (const leftover of releasedList) {
            if (!leftover.itemBatchId) continue;
            touchedItemIds.add(releasedItemId.toString());
            await deleteStockByBatchId({
              stockData: {
                itemId: releasedItemId,
                companyId: bill.companyId,
                warehouseId: bill.warehouseId,
                itemBatchId: leftover.itemBatchId,
              },
              session,
            });
          }
        }

        await checkCompanyStockLevels({
          itemIds: [...touchedItemIds],
          companyId: bill.companyId,
          docType: MODULE_NAMES.BILL,
          docId: billId,
          docNo: bill.billId,
          userId,
          session,
        });
      }

      // Stock sync (when enabled) already resolved each line's own batches; otherwise carry old batches over per line.
      bill.items = newItems.map((newItem, index) => ({
        ...newItem,
        batches: lineBatches ? lineBatches[index] : newItem.batches?.length ? newItem.batches : lineMatches[index]?.batches || [],
      }));
    }

    otherUpdateBody.total = total;
    otherUpdateBody.vendor = vendor;
    otherUpdateBody.branchId = branchId;
    otherUpdateBody.balanceAmount = total;
    otherUpdateBody.authorizedSignature = company?.authorizedSignature;
    // Update the bill with other fields
    Object.assign(bill, {
      ...otherUpdateBody,
      attachments: allAttachments,
      inventoryConfig: latestInventoryConfig,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    });
    if (warehouseId) {
      bill.warehouseId = warehouseId;
    }

    // Update modification details
    bill.updatedBy = userId;
    let updateMsg = 'Bill updated.';
    if (oldtotal !== total) {
      updateMsg = `Bill  updated. Amount changed from ${currencyDoc?.symbol || '₹'}${oldtotal} to ${currencyDoc?.symbol || '₹'}${total}`;
    }
    bill.commentHistory.push({
      message: updateMsg,
      addedBy: userId,
      createdAt: new Date(),
    });
    await bill.save({ session });

    //update customer currentBalance
    let newCurrentBalance = total;
    if (newCurrentBalance == oldtotal) {
      newCurrentBalance = 0;
    }
    if (newCurrentBalance != oldtotal) {
      newCurrentBalance = total - oldtotal;
    }

    await updateBranchCurrentBalance({
      customerId: vendor,
      branchId,
      amount: newCurrentBalance,
      session,
    });
    // Update PO or GRPO status
    if (bill.purchaseOrderId) {
      await recomputePurchaseOrderStatus(bill.purchaseOrderId, session);
    }

    if (bill?.grpoIds?.length > 0) {
      for (const grpo of bill.grpoIds) {
        await updateGRPOStatus(grpo.grpoId, bill._id, session);
      }
    }

    await syncBillJournal(bill.companyId, bill, userId, session);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return enrichDocumentCurrency(bill.companyId, bill.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

// Helper function to update GRPO status
const updateGRPOStatus = async (grpoId, billId, session) => {
  const { GrpoOrder, Bill } = getBooksModels();
  const grpoOrder = await GrpoOrder.findById(grpoId).session(session);
  if (!grpoOrder) return;

  // Calculate total billed quantity
  let totalBilledQty = 0;
  for (const c of grpoOrder.convertedTo.filter(c => c.type === 'BILL')) {
    if (c.documentId.toString() === billId.toString()) continue; // Skip the current bill

    const billDoc = await Bill.findById(c.documentId).session(session);
    if (billDoc && billDoc.status !== BILL_STATUSES.CANCELLED) {
      totalBilledQty += billDoc.items.reduce((sum, i) => sum + i.quantity, 0);
    }
  }

  // Add the current bill
  const currentBill = await Bill.findById(billId).session(session);
  if (currentBill && currentBill.status !== BILL_STATUSES.CANCELLED) {
    totalBilledQty += currentBill.items.reduce((sum, i) => sum + i.quantity, 0);
  }

  const totalGrpoQty = grpoOrder.items.reduce((sum, i) => sum + i.quantity, 0);
  grpoOrder.status = totalBilledQty >= totalGrpoQty ? GRPO_STATUSES.CONVERTED : GRPO_STATUSES.RECORDED;

  await grpoOrder.save({ session });
};

const deleteBillById = async (billId, companyId, userId) => {
  const { PurchaseOrder, GrpoOrder, Bill, PaymentMade, DebitNote, RecurringBills, RecurringBillHistory } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const bill = await Bill.findOne({ _id: billId, companyId }).session(session);
    const billNo = bill?.billId;
    if (!bill) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found');
    }
    const relatedBillIds = [bill._id];
    if (bill.splitBillId) {
      relatedBillIds.push(new mongoose.Types.ObjectId(bill.splitBillId));
    }

    const billsForCreditCheck = await Bill.find({ _id: { $in: relatedBillIds } })
      .select('openingBalanceApplications')
      .session(session)
      .lean();
    if (billsForCreditCheck.some(b => (b.openingBalanceApplications || []).length > 0)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Cannot delete Bill because vendor credit has been applied to it. Remove the credit applications first.',
      );
    }

    const paymentMade = await PaymentMade.find({
      bills: {
        $elemMatch: {
          billId: { $in: relatedBillIds },
        },
      },
    }).session(session);

    if (paymentMade.length > 0) {
      const orderIds = paymentMade.map(inv => inv.paymentMadeId).join(', ');

      throw new ApiError(httpStatus.BAD_REQUEST, `Cannot delete Bill because a PaymentMade has been created from it:${orderIds}`);
    }

    const debitNote = await DebitNote.find({
      $or: [
        { billId: { $in: relatedBillIds } },
        {
          billsApplied: {
            $elemMatch: {
              billId: { $in: relatedBillIds },
            },
          },
        },
      ],
    }).session(session);

    if (debitNote.length > 0) {
      const orderIds = debitNote.map(inv => inv.debitNoteId).join(', ');

      throw new ApiError(httpStatus.BAD_REQUEST, `Cannot delete Bill because a DebitNote has been created from it:${orderIds}`);
    }

    //stock effects

    if (bill.inventoryConfig?.stockAddEnabled && bill.status != BILL_STATUSES.CANCELLED) {
      if (bill?.splitBillId) {
        let splitBill, mainBill;

        if (bill?.isSplit) {
          splitBill = bill;
          mainBill = await Bill.findById(bill?.splitBillId).session(session);
        } else {
          mainBill = bill;
          splitBill = await Bill.findById(bill?.splitBillId).session(session);
        }

        if (splitBill?.splitWiseType == 'Split By Price') {
          for (let i of mainBill?.items) {
            const warehouseStockObj = {
              action: 'deleteStock',
              stockData: {
                itemId: i.itemId,
                companyId: mainBill.companyId,
                branchId: mainBill.branchId,
                warehouseId: mainBill.warehouseId,
                deductedSourceType: MODULE_NAMES.BILL,
                deductedSourceId: mainBill?._id,
              },
              session,
            };

            await handleWarehouseStock(warehouseStockObj);
          }

          await checkCompanyStockLevels({
            itemIds: mainBill.items.map(i => i.itemId),
            companyId: mainBill.companyId,
            docType: MODULE_NAMES.BILL,
            docId: mainBill._id,
            docNo: mainBill.billId,
            userId,
            session,
          });
        }

        if (splitBill?.splitWiseType == 'Split By Qty') {
          for (let i of mainBill?.items) {
            const warehouseStockObj = {
              action: 'deleteStock',
              stockData: {
                itemId: i.itemId,
                companyId: mainBill.companyId,
                branchId: mainBill.branchId,
                warehouseId: mainBill.warehouseId,
                deductedSourceType: MODULE_NAMES.BILL,
                deductedSourceId: mainBill?._id,
              },
              session,
            };

            await handleWarehouseStock(warehouseStockObj);
          }

          await checkCompanyStockLevels({
            itemIds: mainBill.items.map(i => i.itemId),
            companyId: mainBill.companyId,
            docType: MODULE_NAMES.BILL,
            docId: mainBill._id,
            docNo: mainBill.billId,
            userId,
            session,
          });
        }
      } else if (bill?.isSplit && !bill?.splitBillId) {
        for (let i of bill?.items) {
          const warehouseStockObj = {
            action: 'deleteStock',
            stockData: {
              itemId: i.itemId,
              companyId: bill.companyId,
              branchId: bill.branchId,
              warehouseId: bill.warehouseId,
              deductedSourceType: MODULE_NAMES.SPLIT_BILL,
              deductedSourceId: billId,
            },
            session,
          };

          await handleWarehouseStock(warehouseStockObj);
        }

        await checkCompanyStockLevels({
          itemIds: bill.items.map(i => i.itemId),
          companyId: bill.companyId,
          docType: MODULE_NAMES.SPLIT_BILL,
          docId: billId,
          docNo: bill.billId,
          userId,
          session,
        });
      } else {
        for (let i of bill?.items) {
          const warehouseStockObj = {
            action: 'deleteStock',
            stockData: {
              itemId: i.itemId,
              companyId: bill.companyId,
              branchId: bill.branchId,
              warehouseId: bill.warehouseId,
              deductedSourceType: MODULE_NAMES.BILL,
              deductedSourceId: billId,
            },
            session,
          };

          await handleWarehouseStock(warehouseStockObj);
        }

        await checkCompanyStockLevels({
          itemIds: bill.items.map(i => i.itemId),
          companyId: bill.companyId,
          docType: MODULE_NAMES.BILL,
          docId: billId,
          docNo: bill.billId,
          userId,
          session,
        });
      }
    }

    // const combinedItemsMap = new Map();

    //parent document update
    let poEffectBill = bill;

    if (bill.isSplit === true) {
      // poEffectBill = await Bill.findById(bill.splitBillId).session(session);
      // if (!poEffectBill) {
      //   throw new ApiError(httpStatus.BAD_REQUEST, 'Main Bill not found for split bill');
      // }
    }

    if (poEffectBill?.purchaseOrders?.length > 0) {
      const purchaseOrderIds = [
        ...new Set(poEffectBill.purchaseOrders.map(po => po.purchaseOrderId?.toString()).filter(Boolean)),
      ];

      for (const purchaseOrderId of purchaseOrderIds) {
        const existingComment = await PurchaseOrder.findOne({
          _id: new mongoose.Types.ObjectId(purchaseOrderId),
          'commentHistory.referenceId': poEffectBill._id,
        }).session(session);

        const baseUpdate = {
          $pull: {
            convertedTo: {
              documentId: new mongoose.Types.ObjectId(poEffectBill._id),
            },
          },
          $set: {
            updatedBy: userId,
          },
        };

        if (existingComment) {
          await PurchaseOrder.updateOne(
            { _id: new mongoose.Types.ObjectId(purchaseOrderId) },
            {
              ...baseUpdate,
              $set: {
                ...baseUpdate.$set,
                'commentHistory.$[target].isDeleted': true,
              },
            },
            {
              arrayFilters: [{ 'target.referenceId': poEffectBill._id }],
              session,
            },
          );
        } else {
          await PurchaseOrder.updateOne({ _id: new mongoose.Types.ObjectId(purchaseOrderId) }, baseUpdate, { session });
        }

        await PurchaseOrder.updateOne(
          { _id: new mongoose.Types.ObjectId(purchaseOrderId) },
          {
            $push: {
              commentHistory: {
                message: `Bill No ${billNo} deleted successfully`,
                addedBy: userId,
                createdAt: new Date(),
              },
            },
          },
          { session },
        );
      }
    }

    if (poEffectBill?.grpoIds?.length > 0) {
      for (const grpo of poEffectBill.grpoIds) {
        const grpoId = grpo.grpoId;

        const existingComment = await GrpoOrder.findOne({
          _id: grpoId,
          'commentHistory.referenceId': poEffectBill._id,
        }).session(session);

        const baseUpdate = {
          $set: {
            status: GRPO_STATUSES.RECORDED,
            updatedBy: userId,
          },
          $pull: {
            convertedTo: {
              documentId: new mongoose.Types.ObjectId(poEffectBill._id),
            },
          },
        };

        if (existingComment) {
          await GrpoOrder.updateOne(
            { _id: grpoId },
            {
              ...baseUpdate,
              $set: {
                ...baseUpdate.$set,
                'commentHistory.$[target].isDeleted': true,
              },
            },
            {
              arrayFilters: [{ 'target.referenceId': poEffectBill._id }],
              session,
            },
          );
        } else {
          await GrpoOrder.updateOne({ _id: grpoId }, baseUpdate, { session });
        }

        if (!bill.isSplit) {
          await GrpoOrder.updateOne(
            { _id: grpoId },
            {
              $push: {
                commentHistory: {
                  message: `Bill No ${billNo} deleted successfully`,
                  addedBy: userId,
                  createdAt: new Date(),
                },
              },
            },
            { session },
          );
        }
      }
    }

    let balanceBills = [];

    if (!bill.isSplit) {
      balanceBills = [bill];
    } else if (bill?.isSplit && !bill?.splitWiseType) {
      balanceBills = [bill];
    } else {
      const relatedBill = bill.splitBillId ? await Bill.findById(bill.splitBillId).session(session) : null;
      if (relatedBill) {
        balanceBills = [bill, relatedBill];
      } else {
        balanceBills = [bill];
      }
    }

    for (const balanceBill of balanceBills) {
      if (balanceBill.status === BILL_STATUSES.CANCELLED) continue;

      await updateBranchCurrentBalance({
        customerId: balanceBill.vendor,
        branchId: balanceBill.branchId,
        amount: -Number(balanceBill.total),
        session,
      });
    }

    const recurringBillWithComment = await RecurringBills.findOne({
      'commentHistory.referenceId': bill._id,
    }).session(session);

    if (recurringBillWithComment) {
      await RecurringBills.updateOne(
        { _id: recurringBillWithComment._id },
        {
          $set: {
            'commentHistory.$[target].isDeleted': true,
          },
        },
        {
          arrayFilters: [{ 'target.referenceId': bill._id }],
          session,
        },
      );
    }

    for (const relatedBillId of relatedBillIds) {
      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.BILL, sourceId: relatedBillId },
        session,
      );
    }

    // Flag the recurring execution log's generated bill as deleted (keep the
    // id/number for the audit trail) so its "Generated Bill" link doesn't point
    // at a deleted document.
    await RecurringBillHistory.updateMany(
      { companyId, generatedBillId: { $in: relatedBillIds } },
      { $set: { isGeneratedDeleted: true, generatedDeletedAt: new Date() } },
      { session },
    );

    await Bill.deleteMany({ _id: { $in: relatedBillIds } }).session(session);

    if (poEffectBill?.purchaseOrders?.length > 0) {
      const purchaseOrderIds = [
        ...new Set(poEffectBill.purchaseOrders.map(po => po.purchaseOrderId?.toString()).filter(Boolean)),
      ];
      for (const purchaseOrderId of purchaseOrderIds) {
        await recomputePurchaseOrderStatus(purchaseOrderId, session);
      }
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const queryPendingBills = async (filter, options) => {
  const { Bill, Expenses } = getBooksModels();
  const { OpeningBalanceTransaction, Branch } = getBooksCrmModels();
  const isCreditMapping = filter?.forCreditMapping;
  delete filter.forCreditMapping;
  const allowCrossBranchMapping = !!filter?.allowCrossBranchMapping;
  delete filter.allowCrossBranchMapping;
  const creditBranchId = filter.creditBranchId ? new mongoose.Types.ObjectId(filter.creditBranchId) : null;
  delete filter.creditBranchId;
  if (filter.branchId) {
    filter.branchId = new mongoose.Types.ObjectId(filter.branchId);
  }
  const paymentBranchId = filter.branchId;
  if (allowCrossBranchMapping) {
    delete filter.branchId;
  }
  filter.balanceAmount = { $gt: 0 };
  filter.status = { $in: [BILL_STATUSES.OPEN, BILL_STATUSES.PARTIALLY_PAID, BILL_STATUSES.OVERDUE] };

  if (filter?.isSplit == undefined) {
    filter.isSplit = false;
  }

  const bills = await Bill.find(filter)
    .select('billId dueDate total status paidAmount balanceAmount isSplit billDate branchId')
    .sort({ dueDate: 1 })
    .lean();

  let openingBalanceTransactions = [];
  if (filter.vendor) {
    const obTypes = isCreditMapping
      ? [TRANSACTION_TYPE.VENDOR_CREDIT, TRANSACTION_TYPE.OPENING_PAYABLE]
      : [TRANSACTION_TYPE.OPENING_PAYABLE];
    const obBranchId = allowCrossBranchMapping ? null : creditBranchId || paymentBranchId;
    const obFilter = {
      contactId: new mongoose.Types.ObjectId(filter.vendor),
      contactType: 'vendor',
      type: { $in: obTypes },
      remainingAmount: { $gt: 0 },
      ...(filter.companyId && { companyId: new mongoose.Types.ObjectId(filter.companyId) }),
      ...(obBranchId && { branchId: obBranchId }),
    };
    const openingBalanceList = await OpeningBalanceTransaction.find(obFilter)
      .select('transactionNo date amount remainingAmount branchId type')
      .sort({ date: 1 })
      .lean();

    openingBalanceTransactions = await attachBranchNames(Branch, openingBalanceList || []);
  }

  let pendingExpenses = [];
  if (filter.vendor && !isCreditMapping && !filter.isSplit) {
    const expenseList = await Expenses.find({
      companyId: new mongoose.Types.ObjectId(filter.companyId),
      party: new mongoose.Types.ObjectId(filter.vendor),
      partyType: LEDGER_PARTY_TYPES.VENDOR,
      isBillable: true,
      balanceAmount: { $gt: 0 },
      ...(filter.branchId && { branchId: filter.branchId }),
    })
      .select('expenseId date total paidAmount balanceAmount billableStatus branchId')
      .sort({ date: 1 })
      .lean();
    pendingExpenses = await attachBranchNames(Branch, expenseList);
  }

  return {
    results: await attachBranchNames(Branch, bills || []),
    openingBalanceTransactions,
    pendingExpenses,
  };
};

const getBillsForDropdown = async (filters, options = {}) => {
  const { Bill } = getBooksModels();
  const { search, ...restFilters } = filters;

  const query = {
    ...restFilters,
    status: { $nin: [BILL_STATUSES.DRAFT, BILL_STATUSES.CANCELLED] },
    isSplit: { $ne: true },
  };

  const searchRegex = createSearchRegex(search);
  if (searchRegex) {
    query.billId = searchRegex;
  }

  const result = await Bill.paginate(query, {
    ...options,
    select: 'billId tax',
    sortBy: options.sortBy || 'billDate:desc',
  });

  const results = result.results.map(bill => ({
    _id: bill._id,
    billId: bill.billId,
    tax: bill.tax,
  }));

  return { ...result, results };
};

const applyVendorCreditToBill = async (vendorId, companyId, branchId, applications = [], userId = null, contextBillId = null) => {
  const { Bill } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const vendorObjectId = new mongoose.Types.ObjectId(vendorId);

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const companyProfile = await getCompanyProfile(companyId, session);

    let contextBillNo = null;
    if (contextBillId) {
      const contextBill = await Bill.findOne({
        _id: contextBillId,
        companyId: companyObjectId,
        vendor: vendorObjectId,
      })
        .select('billId')
        .session(session)
        .lean();
      contextBillNo = contextBill?.billId || null;
    }

    for (const { openingBalanceTransactionId, billId, targetOpeningBalanceTransactionId, amountApplied } of applications) {
      if (!openingBalanceTransactionId || !amountApplied || amountApplied <= 0) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Each application must include credit and a positive amount');
      }
      if (!billId && !targetOpeningBalanceTransactionId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Each application must include a bill or opening balance target');
      }
      if (billId && targetOpeningBalanceTransactionId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Provide either bill or opening balance target, not both');
      }

      const creditTxn = await OpeningBalanceTransaction.findOne({
        _id: openingBalanceTransactionId,
        companyId: companyObjectId,
        contactId: vendorObjectId,
        contactType: CONTACT_TYPE.VENDOR,
        type: TRANSACTION_TYPE.VENDOR_CREDIT,
      }).session(session);

      if (!creditTxn) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance credit not found');
      }

      if (creditTxn.remainingAmount < amountApplied) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Applied amount exceeds remaining credit');
      }

      if (targetOpeningBalanceTransactionId) {
        const payableTxn = await OpeningBalanceTransaction.findOne({
          _id: targetOpeningBalanceTransactionId,
          companyId: companyObjectId,
          contactId: vendorObjectId,
          contactType: CONTACT_TYPE.VENDOR,
          type: TRANSACTION_TYPE.OPENING_PAYABLE,
        }).session(session);
        if (!payableTxn) {
          throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance payable not found');
        }
        if (creditTxn.currency && payableTxn.currency && String(creditTxn.currency) !== String(payableTxn.currency)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency credit application is not supported.');
        }
        if (payableTxn.remainingAmount < amountApplied) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Applied amount exceeds opening balance remaining');
        }
        if (String(creditTxn._id) === String(payableTxn._id)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot apply credit to itself');
        }

        const okCredit = await creditTxn.updateRemainingAmount(amountApplied, session);
        if (!okCredit) {
          throw new ApiError(httpStatus.CONFLICT, 'Could not apply credit; please retry');
        }
        const okPayable = await payableTxn.updateRemainingAmount(amountApplied, session);
        if (!okPayable) {
          throw new ApiError(httpStatus.CONFLICT, 'Could not update opening balance; please retry');
        }
        await moveAdvanceApplyBranchBalances({
          customerId: vendorObjectId,
          paymentBranchId: creditTxn.branchId,
          documentBranchId: payableTxn.branchId,
          amount: amountApplied,
          session,
        });

        const obApplicationId = new mongoose.Types.ObjectId();
        const appliedDate = new Date();
        const creditPush = await OpeningBalanceTransaction.findOneAndUpdate(
          { _id: creditTxn._id, companyId: companyObjectId },
          {
            $push: {
              paymentMadeEntries: {
                _id: obApplicationId,
                entrySource: OB_PAYMENT_ENTRY_SOURCE.BILL_CREDIT,
                paymentDocumentNo: payableTxn.transactionNo || `OB-${payableTxn._id}`,
                ...(contextBillNo ? { billNo: contextBillNo } : {}),
                amountApplied,
                appliedDate,
              },
            },
          },
          { session, new: true },
        );
        if (!creditPush) {
          throw new ApiError(httpStatus.CONFLICT, 'Could not record opening balance entry; please retry');
        }
        await ledgerService.postCrossBranchCreditApplyJournal(
          {
            companyId: companyObjectId,
            partyId: vendorObjectId,
            partyType: LEDGER_PARTY_TYPES.VENDOR,
            creditBranchId: creditTxn.branchId,
            documentBranchId: payableTxn.branchId,
            creditDivisionId: creditTxn.divisionId,
            documentDivisionId: payableTxn.divisionId,
            amount: amountApplied,
            postingDate: appliedDate,
            sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY,
            sourceId: obApplicationId,
            narration: `Vendor credit applied to opening balance ${payableTxn.transactionNo || payableTxn._id}`,
            addedBy: userId,
            currencyId: creditTxn.currency || payableTxn.currency,
            exchangeRate: creditTxn.exchangeRate || payableTxn.exchangeRate,
          },
          session,
        );
        continue;
      }

      const bill = await Bill.findOne({
        _id: billId,
        companyId: companyObjectId,
        vendor: vendorObjectId,
      }).session(session);
      if (!bill) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found');
      }

      if (creditTxn.currency && bill.currency && String(creditTxn.currency) !== String(bill.currency)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency credit application is not supported.');
      }

      if (bill.balanceAmount < amountApplied) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Applied amount exceeds bill balance');
      }

      const ok = await creditTxn.updateRemainingAmount(amountApplied, session);
      if (!ok) {
        throw new ApiError(httpStatus.CONFLICT, 'Could not apply credit; please retry');
      }
      await moveAdvanceApplyBranchBalances({
        customerId: vendorObjectId,
        paymentBranchId: creditTxn.branchId,
        documentBranchId: bill.branchId,
        amount: amountApplied,
        session,
      });
      await updateBillPaymentStatus(bill._id, amountApplied, userId, session);
      const billApplicationId = new mongoose.Types.ObjectId();
      const appliedDate = new Date();

      await bill.updateOne(
        {
          $push: {
            openingBalanceApplications: {
              _id: billApplicationId,
              openingBalanceTransactionId: creditTxn._id,
              transactionNo: creditTxn.transactionNo || `OB-${creditTxn._id}`,
              amountApplied,
              appliedDate,
              type: TRANSACTION_TYPE.VENDOR_CREDIT,
            },
            commentHistory: {
              message: `Vendor credit applied for ${companyProfile?.baseCurrency?.symbol || '₹'}${amountApplied}`,
              addedBy: userId,
              createdAt: new Date(),
            },
          },
        },
        { session },
      );
      const obPushResult = await OpeningBalanceTransaction.findOneAndUpdate(
        {
          _id: creditTxn._id,
          companyId: companyObjectId,
          contactId: vendorObjectId,
          contactType: CONTACT_TYPE.VENDOR,
          type: TRANSACTION_TYPE.VENDOR_CREDIT,
        },
        {
          $push: {
            paymentMadeEntries: {
              _id: billApplicationId,
              entrySource: OB_PAYMENT_ENTRY_SOURCE.BILL_CREDIT,
              billId: bill._id,
              billNo: bill.billId,
              billApplicationId,
              paymentDocumentNo: bill.billId,
              amountApplied,
              appliedDate,
            },
          },
        },
        { session, new: true },
      );
      if (!obPushResult) {
        throw new ApiError(httpStatus.CONFLICT, 'Could not record opening balance entry; please retry');
      }
      await ledgerService.postCrossBranchCreditApplyJournal(
        {
          companyId: companyObjectId,
          partyId: vendorObjectId,
          partyType: LEDGER_PARTY_TYPES.VENDOR,
          creditBranchId: creditTxn.branchId,
          documentBranchId: bill.branchId,
          creditDivisionId: creditTxn.divisionId,
          documentDivisionId: bill.divisionId,
          amount: amountApplied,
          postingDate: appliedDate,
          sourceModule: LEDGER_SOURCE_MODULES.BILL,
          sourceId: billApplicationId,
          narration: `Vendor credit applied to bill ${bill.billId}`,
          addedBy: userId,
          currencyId: bill.currency || creditTxn.currency,
          exchangeRate: bill.exchangeRate || creditTxn.exchangeRate,
        },
        session,
      );
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return { success: true };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const autoMapOpeningBalanceToBills = async (filter = {}) => {
  const { companyId, vendorId, branchId, isSplit } = filter;
  const { Bill } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const creditMatch = {
    companyId: companyObjectId,
    contactType: CONTACT_TYPE.VENDOR,
    type: TRANSACTION_TYPE.VENDOR_CREDIT,
    remainingAmount: { $gt: 0 },
    ...(vendorId ? { contactId: new mongoose.Types.ObjectId(vendorId) } : {}),
    ...(branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : {}),
  };

  const creditGroups = await OpeningBalanceTransaction.aggregate([
    { $match: creditMatch },
    { $sort: { contactId: 1, branchId: 1, date: 1, createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: { vendorId: '$contactId', branchId: '$branchId' },
        creditIds: { $push: '$_id' },
      },
    },
  ]);

  if (!creditGroups.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No opening balance credits available for auto mapping');
  }

  let groupsProcessed = 0;
  let mappedCredits = 0;
  let mappedBills = 0;
  let totalMappedAmount = 0;
  let attemptedMappings = 0;
  let successfulMappings = 0;
  let failedMappings = 0;
  const failures = [];
  let hasPendingBills = false;

  for (const group of creditGroups) {
    const { vendorId, branchId } = group._id;

    const pendingBills = await Bill.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          vendor: vendorId,
          branchId,
          balanceAmount: { $gt: 0 },
          status: {
            $in: [BILL_STATUSES.OPEN, BILL_STATUSES.PARTIALLY_PAID, BILL_STATUSES.OVERDUE],
          },
          ...(isSplit !== undefined ? { isSplit: !!isSplit } : {}),
        },
      },
      { $project: { _id: 1, billId: 1, dueDate: 1, createdAt: 1, balanceAmount: 1 } },
      { $sort: { dueDate: 1, createdAt: 1, _id: 1 } },
    ]);

    if (!pendingBills.length) continue;
    hasPendingBills = true;

    const creditIdsInOrder = group.creditIds || [];
    const creditFound = await OpeningBalanceTransaction.find({ _id: { $in: creditIdsInOrder } })
      .select('_id remainingAmount transactionNo')
      .lean();
    const creditMap = new Map(creditFound.map(c => [c._id.toString(), c]));
    const orderedCredits = creditIdsInOrder.map(id => creditMap.get(id.toString())).filter(Boolean);

    const billIdsInOrder = pendingBills.map(bill => bill._id);
    const billFound = await Bill.find({ _id: { $in: billIdsInOrder } })
      .select('_id billId balanceAmount')
      .lean();
    const billMap = new Map(billFound.map(b => [b._id.toString(), b]));
    const orderedBills = billIdsInOrder.map(id => billMap.get(id.toString())).filter(Boolean);

    const creditRemainingMap = new Map(orderedCredits.map(c => [c._id.toString(), Number(c.remainingAmount) || 0]));
    const billRemainingMap = new Map(orderedBills.map(bill => [bill._id.toString(), Number(bill.balanceAmount) || 0]));
    const touchedCreditIds = new Set();

    let creditIndex = 0;
    let billIndex = 0;

    while (creditIndex < orderedCredits.length && billIndex < orderedBills.length) {
      const credit = orderedCredits[creditIndex];
      const bill = orderedBills[billIndex];

      const creditRemaining = creditRemainingMap.get(credit._id.toString()) || 0;
      if (creditRemaining <= 0) {
        creditIndex += 1;
        continue;
      }

      const billRemaining = billRemainingMap.get(bill._id.toString()) || 0;
      if (billRemaining <= 0) {
        billIndex += 1;
        continue;
      }

      const amountApplied = Math.min(creditRemaining, billRemaining);
      if (amountApplied <= 0) break;

      attemptedMappings += 1;
      try {
        await applyVendorCreditToBill(vendorId, companyId, branchId, [
          {
            openingBalanceTransactionId: credit._id,
            billId: bill._id,
            amountApplied,
          },
        ]);
      } catch (error) {
        failedMappings += 1;
        if (failures.length < 100) {
          failures.push({
            openingBalanceTransactionId: credit._id,
            transactionNo: credit.transactionNo || `OB-${credit._id}`,
            billId: bill._id,
            billNo: bill.billId,
            amountApplied,
            message: error?.message || 'Failed to auto map opening balance to bill',
          });
        }
        billIndex += 1;
        continue;
      }

      touchedCreditIds.add(credit._id.toString());
      creditRemainingMap.set(credit._id.toString(), creditRemaining - amountApplied);
      billRemainingMap.set(bill._id.toString(), billRemaining - amountApplied);
      totalMappedAmount += amountApplied;
      mappedBills += 1;
      successfulMappings += 1;

      if ((creditRemainingMap.get(credit._id.toString()) || 0) <= 0) creditIndex += 1;
      if ((billRemainingMap.get(bill._id.toString()) || 0) <= 0) billIndex += 1;
    }

    if (touchedCreditIds.size > 0) {
      groupsProcessed += 1;
      mappedCredits += touchedCreditIds.size;
      await OpeningBalanceTransaction.updateMany(
        { _id: { $in: [...touchedCreditIds].map(id => new mongoose.Types.ObjectId(id)) } },
        { $set: { updatedAt: new Date() } },
      );
    }
  }

  if (!hasPendingBills) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No pending bills found for auto mapping');
  }

  return {
    groupsProcessed,
    mappedCredits,
    mappedBills,
    totalMappedAmount,
    attemptedMappings,
    successfulMappings,
    failedMappings,
    failures,
    success: hasPendingBills && failedMappings === 0,
  };
};

const removeOpeningBalanceApplicationFromBill = async (billId, companyId, applicationId, userId = null) => {
  const { Bill } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const applicationObjectId = new mongoose.Types.ObjectId(applicationId);

  const billForLookup = await Bill.findOne({ _id: billId, companyId: companyObjectId }).select(
    'vendor openingBalanceApplications',
  );
  if (!billForLookup) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found');
  }
  const onBill = billForLookup.openingBalanceApplications?.id?.(applicationId);
  if (!onBill) {
    const credit = await OpeningBalanceTransaction.findOne({
      companyId: companyObjectId,
      contactId: billForLookup.vendor,
      contactType: CONTACT_TYPE.VENDOR,
      type: TRANSACTION_TYPE.VENDOR_CREDIT,
      $or: [{ 'paymentMadeEntries._id': applicationObjectId }, { 'paymentMadeEntries.billApplicationId': applicationObjectId }],
    });
    const entry = (credit?.paymentMadeEntries || []).find(
      e =>
        !e.billId &&
        e.paymentDocumentNo &&
        (String(e._id) === String(applicationObjectId) || String(e.billApplicationId) === String(applicationObjectId)),
    );
    if (entry && credit) {
      return removeOpeningBalanceApplicationFromOb(String(credit._id), companyId, applicationId);
    }
    throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance application not found');
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const bill = await Bill.findOne({ _id: billId, companyId: companyObjectId }).session(session);
    if (!bill) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found');
    }

    const companyProfile = await getCompanyProfile(companyId, session);

    const sub = bill.openingBalanceApplications.id(applicationId);
    if (!sub) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance application not found');
    }

    const amountToRestore = Number(sub.amountApplied);
    if (!Number.isFinite(amountToRestore) || amountToRestore <= 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid amount on opening balance application');
    }

    if (!sub._id) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid opening balance application');
    }

    const obUpdated = await OpeningBalanceTransaction.findOneAndUpdate(
      {
        _id: sub.openingBalanceTransactionId,
        companyId: companyObjectId,
        contactId: bill.vendor,
        contactType: CONTACT_TYPE.VENDOR,
        type: TRANSACTION_TYPE.VENDOR_CREDIT,
      },
      {
        $inc: { remainingAmount: amountToRestore },
        $pull: {
          paymentMadeEntries: {
            $or: [{ billApplicationId: sub._id }, { _id: sub._id }],
          },
        },
      },
      { session, new: true },
    );

    if (!obUpdated) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'This opening balance application cannot be removed');
    }

    await moveAdvanceApplyBranchBalances({
      customerId: bill.vendor,
      paymentBranchId: obUpdated.branchId,
      documentBranchId: bill.branchId,
      amount: amountToRestore,
      session,
      reverse: true,
    });

    await ledgerService.deleteJournal(
      { companyId: companyObjectId, sourceModule: LEDGER_SOURCE_MODULES.BILL, sourceId: sub._id },
      session,
    );

    const ok = await updateBillPaymentStatus(bill._id, -amountToRestore, userId, session);
    if (!ok) {
      throw new ApiError(httpStatus.CONFLICT, 'Could not update bill; please retry');
    }

    await Bill.updateOne(
      { _id: bill._id, companyId: companyObjectId },
      {
        $pull: { openingBalanceApplications: { _id: sub._id } },
        $push: {
          commentHistory: {
            message: `Vendor credit removed for ${companyProfile?.baseCurrency?.symbol || '₹'}${amountToRestore}`,
            addedBy: userId,
            createdAt: new Date(),
          },
        },
      },
      { session },
    );

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return { success: true };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const removeOpeningBalanceApplicationFromOb = async (creditTxnId, companyId, applicationId) => {
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const applicationObjectId = new mongoose.Types.ObjectId(applicationId);

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const creditTxn = await OpeningBalanceTransaction.findOne({
      _id: creditTxnId,
      companyId: companyObjectId,
      contactType: CONTACT_TYPE.VENDOR,
      type: TRANSACTION_TYPE.VENDOR_CREDIT,
    }).session(session);

    if (!creditTxn) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance credit not found');
    }

    const entry = (creditTxn.paymentMadeEntries || []).find(e => {
      if (e.billId || !e.paymentDocumentNo) return false;
      return String(e._id) === String(applicationObjectId) || String(e.billApplicationId) === String(applicationObjectId);
    });
    if (!entry) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance application not found');
    }

    const amountToRestore = Number(entry.amountApplied);
    if (!Number.isFinite(amountToRestore) || amountToRestore <= 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid amount on opening balance application');
    }

    const payableDocNo = String(entry.paymentDocumentNo);
    let payableTxn = await OpeningBalanceTransaction.findOne({
      companyId: companyObjectId,
      contactId: creditTxn.contactId,
      contactType: CONTACT_TYPE.VENDOR,
      type: TRANSACTION_TYPE.OPENING_PAYABLE,
      transactionNo: payableDocNo,
    }).session(session);

    if (!payableTxn && payableDocNo.startsWith('OB-')) {
      const maybeId = payableDocNo.slice(3);
      if (mongoose.Types.ObjectId.isValid(maybeId)) {
        payableTxn = await OpeningBalanceTransaction.findOne({
          _id: maybeId,
          companyId: companyObjectId,
          contactId: creditTxn.contactId,
          type: TRANSACTION_TYPE.OPENING_PAYABLE,
        }).session(session);
      }
    }

    if (!payableTxn) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance payable not found');
    }

    if (!entry._id) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid opening balance application');
    }

    const creditUpdated = await OpeningBalanceTransaction.findOneAndUpdate(
      { _id: creditTxn._id, companyId: companyObjectId },
      {
        $inc: { remainingAmount: amountToRestore },
        $pull: { paymentMadeEntries: { _id: entry._id } },
      },
      { session, new: true },
    );
    if (!creditUpdated) {
      throw new ApiError(httpStatus.CONFLICT, 'Could not remove credit application; please retry');
    }
    const stillThere = (creditUpdated.paymentMadeEntries || []).some(e => String(e._id) === String(entry._id));
    if (stillThere) {
      throw new ApiError(httpStatus.CONFLICT, 'Could not remove credit application; please retry');
    }

    const payableUpdated = await OpeningBalanceTransaction.findOneAndUpdate(
      { _id: payableTxn._id, companyId: companyObjectId },
      { $inc: { remainingAmount: amountToRestore } },
      { session, new: true },
    );
    if (!payableUpdated) {
      throw new ApiError(httpStatus.CONFLICT, 'Could not restore opening balance payable; please retry');
    }

    await moveAdvanceApplyBranchBalances({
      customerId: creditTxn.contactId,
      paymentBranchId: creditTxn.branchId,
      documentBranchId: payableTxn.branchId,
      amount: amountToRestore,
      session,
      reverse: true,
    });

    await ledgerService.deleteJournal(
      { companyId: companyObjectId, sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY, sourceId: entry._id },
      session,
    );

    await flushCompanyStockLevels(session);
    await session.commitTransaction();
    return { success: true };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const updateBillStatus = async (billId, companyId, newStatus, userId) => {
  const { GrpoOrder, Bill, PaymentMade, DebitNote, RecurringBills } = getBooksModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const bill = await Bill.findOne({ _id: billId, companyId }).session(session);
    if (!bill) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found');
    }

    const oldStatus = bill.status;

    // Validate status transition (the cancel action is handled specially below)
    if (newStatus !== BILL_STATUSES.CANCELLED) {
      validateStatusTransition(BILL_STATUS_CONFIG.STATUS_TRANSITIONS, oldStatus, newStatus);
    }

    const relatedBillIds = [bill._id];
    if (bill.splitBillId) {
      relatedBillIds.push(new mongoose.Types.ObjectId(bill.splitBillId));
    }

    let cancelPurchaseOrderIds = [];

    if (newStatus == BILL_STATUSES.CANCELLED && bill.status != BILL_STATUSES.CANCELLED) {
      const paymentMade = await PaymentMade.find({
        status: { $ne: PAYMENT_STATUS.CANCELLED },
        bills: {
          $elemMatch: {
            billId: { $in: relatedBillIds },
          },
        },
      }).session(session);

      if (paymentMade.length > 0) {
        const orderIds = paymentMade.map(inv => inv.paymentMadeId).join(', ');

        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot cancel Bill because an active Payment Made is mapped to it:${orderIds}`,
        );
      }

      const debitNote = await DebitNote.find({
        status: { $ne: DEBIT_NOTE_STATUS.CANCELLED },
        $or: [
          { billId: { $in: relatedBillIds } },
          {
            billsApplied: {
              $elemMatch: {
                billId: { $in: relatedBillIds },
              },
            },
          },
        ],
      }).session(session);

      if (debitNote.length > 0) {
        const orderIds = debitNote.map(inv => inv.debitNoteId).join(', ');

        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot cancel Bill because a Debit Note has been created from it:${orderIds}`,
        );
      }

      const billWithOpeningBalanceVendorCredit = await Bill.findOne({
        _id: { $in: relatedBillIds },
        companyId,
        openingBalanceApplications: {
          $elemMatch: { type: TRANSACTION_TYPE.VENDOR_CREDIT },
        },
      })
        .session(session)
        .select('_id')
        .lean();

      if (billWithOpeningBalanceVendorCredit) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'This bill cannot be canceled because it is linked to opening balance credit entries.',
        );
      }

      // Remove batches created by this bill when cancelling (separate condition for clarity)
      //stock effects

      if (bill.inventoryConfig?.stockAddEnabled) {
        if (bill?.splitBillId) {
          let splitBill, mainBill;

          if (bill?.isSplit) {
            splitBill = bill;
            mainBill = await Bill.findById(bill?.splitBillId).session(session);
          } else {
            mainBill = bill;
            splitBill = await Bill.findById(bill?.splitBillId).session(session);
          }

          if (splitBill?.splitWiseType == 'Split By Price') {
            for (let i of mainBill?.items) {
              const warehouseStockObj = {
                action: 'deleteStock',
                stockData: {
                  itemId: i.itemId,
                  companyId: mainBill.companyId,
                  branchId: mainBill.branchId,
                  warehouseId: mainBill.warehouseId,
                  deductedSourceType: MODULE_NAMES.BILL,
                  deductedSourceId: mainBill?._id,
                },
                session,
              };

              await handleWarehouseStock(warehouseStockObj);
            }

            await checkCompanyStockLevels({
              itemIds: mainBill.items.map(i => i.itemId),
              companyId: mainBill.companyId,
              docType: MODULE_NAMES.BILL,
              docId: mainBill._id,
              docNo: mainBill.billId,
              userId,
              session,
            });
          }

          if (splitBill?.splitWiseType == 'Split By Qty') {
            for (let i of mainBill?.items) {
              const warehouseStockObj = {
                action: 'deleteStock',
                stockData: {
                  itemId: i.itemId,
                  companyId: mainBill.companyId,
                  branchId: mainBill.branchId,
                  warehouseId: mainBill.warehouseId,
                  deductedSourceType: MODULE_NAMES.BILL,
                  deductedSourceId: mainBill?._id,
                },
                session,
              };

              await handleWarehouseStock(warehouseStockObj);
            }

            await checkCompanyStockLevels({
              itemIds: mainBill.items.map(i => i.itemId),
              companyId: mainBill.companyId,
              docType: MODULE_NAMES.BILL,
              docId: mainBill._id,
              docNo: mainBill.billId,
              userId,
              session,
            });
          }
        } else if (bill?.isSplit && !bill?.splitBillId) {
          for (let i of bill?.items) {
            const warehouseStockObj = {
              action: 'deleteStock',
              stockData: {
                itemId: i.itemId,
                companyId: bill.companyId,
                branchId: bill.branchId,
                warehouseId: bill.warehouseId,
                deductedSourceType: MODULE_NAMES.SPLIT_BILL,
                deductedSourceId: billId,
              },
              session,
            };

            await handleWarehouseStock(warehouseStockObj);
          }

          await checkCompanyStockLevels({
            itemIds: bill.items.map(i => i.itemId),
            companyId: bill.companyId,
            docType: MODULE_NAMES.SPLIT_BILL,
            docId: billId,
            docNo: bill.billId,
            userId,
            session,
          });
        } else {
          for (let i of bill?.items) {
            const warehouseStockObj = {
              action: 'deleteStock',
              stockData: {
                itemId: i.itemId,
                companyId: bill.companyId,
                branchId: bill.branchId,
                warehouseId: bill.warehouseId,
                deductedSourceType: MODULE_NAMES.BILL,
                deductedSourceId: billId,
              },
              session,
            };

            await handleWarehouseStock(warehouseStockObj);
          }

          await checkCompanyStockLevels({
            itemIds: bill.items.map(i => i.itemId),
            companyId: bill.companyId,
            docType: MODULE_NAMES.BILL,
            docId: billId,
            docNo: bill.billId,
            userId,
            session,
          });
        }

        await Bill.updateMany(
          { _id: { $in: relatedBillIds } },
          {
            $set: {
              'items.$[].batches': [],
            },
          },
          { session },
        );
      }

      //parent document update
      let poEffectBill = bill;

      if (bill.isSplit === true) {
        // poEffectBill = await Bill.findById(bill.splitBillId).session(session);
        // if (!poEffectBill) {
        //   throw new ApiError(httpStatus.BAD_REQUEST, 'Main Bill not found for split bill');
        // }
      }

      if (poEffectBill?.purchaseOrders?.length > 0) {
        cancelPurchaseOrderIds = [
          ...new Set(poEffectBill.purchaseOrders.map(po => po.purchaseOrderId?.toString()).filter(Boolean)),
        ];
        await calculateRemainingQty(poEffectBill?.items, poEffectBill._id, poEffectBill.billId, userId, session);
      }

      if (poEffectBill?.grpoIds?.length > 0) {
        for (const grpo of poEffectBill.grpoIds) {
          const grpoId = grpo.grpoId;

          await GrpoOrder.updateOne(
            { _id: grpoId },
            {
              $set: {
                status: GRPO_STATUSES.RECORDED,
                'commentHistory.$[target].isCancelled': true,

                updatedBy: userId,
              },
            },
            {
              arrayFilters: [{ 'target.referenceId': poEffectBill._id }],
              session,
            },
          );

          await GrpoOrder.updateOne(
            { _id: grpoId },
            {
              $push: {
                commentHistory: {
                  message: `Bill No ${poEffectBill.billId} cancelled successfully`,
                  addedBy: userId,
                  createdAt: new Date(),
                },
              },
            },
            { session },
          );
        }
      }

      //update customer currentBalance
      let balanceBills = [];

      if (!bill.isSplit) {
        balanceBills = [bill];
      } else if (bill?.isSplit && !bill?.splitWiseType) {
        balanceBills = [bill];
      } else {
        const relatedBill = bill.splitBillId ? await Bill.findById(bill.splitBillId).session(session) : null;
        if (relatedBill) {
          balanceBills = [bill, relatedBill];
        } else {
          balanceBills = [bill];
        }
      }

      for (const balanceBill of balanceBills) {
        if (balanceBill.status === BILL_STATUSES.CANCELLED) continue;

        await updateBranchCurrentBalance({
          customerId: balanceBill.vendor,
          branchId: balanceBill.branchId,
          amount: -Number(balanceBill.total),
          session,
        });
      }

      const recurringBillWithComment = await RecurringBills.findOne({
        'commentHistory.referenceId': bill._id,
      }).session(session);

      if (recurringBillWithComment) {
        await RecurringBills.updateOne(
          { _id: recurringBillWithComment._id },
          {
            $set: {
              'commentHistory.$[target].isCancelled': true,
            },
          },
          {
            arrayFilters: [{ 'target.referenceId': bill._id }],
            session,
          },
        );
      }
    }

    const relatedBeforeUpdate = await Bill.find({ _id: { $in: relatedBillIds } }).session(session);
    const oldStatusById = new Map(relatedBeforeUpdate.map(doc => [doc._id.toString(), doc.status]));

    for (const relatedBill of relatedBeforeUpdate) {
      await Bill.updateOne(
        { _id: relatedBill._id },
        {
          $set: { status: newStatus, updatedBy: userId },
          $push: {
            commentHistory: {
              message: `Bill status updated from ${relatedBill.status} to ${newStatus}`,
              addedBy: userId,
              createdAt: new Date(),
            },
          },
        },
        { session },
      );
    }

    for (const purchaseOrderId of cancelPurchaseOrderIds) {
      await recomputePurchaseOrderStatus(purchaseOrderId, session);
    }

    await bill.save({ session });

    // Ledger follows the persisted status for the bill and its split counterpart.
    const relatedBills = await Bill.find({ _id: { $in: relatedBillIds } }).session(session);
    for (const relatedBill of relatedBills) {
      await syncBillJournal(companyId, relatedBill, userId, session, oldStatusById.get(relatedBill._id.toString()));
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    // Split bills are partial documents generated internally — the vendor-facing
    // notification (email/WhatsApp) only makes sense for the original, unsplit bill.
    if (isFirstStatusChange(oldStatus, newStatus, BILL_STATUSES.DRAFT) && !bill.isSplit) {
      const billForNotification = { ...(bill.toObject?.() || bill), status: newStatus };

      sendModuleCustomerNotifications({
        companyId,
        moduleName: MODULE_NAMES.BILL,
        document: billForNotification,
      }).catch(err => logger.error(`Failed to send bill customer notifications for ${bill.billId}: ${err.message}`));
    }

    bill.status = newStatus;

    if (oldStatus === BILL_STATUSES.DRAFT && newStatus === BILL_STATUSES.OPEN) {
      const { tryAutoPayForBill } = require('../../../services/companyAutoPay.service');
      for (const relatedBillId of relatedBillIds) {
        await tryAutoPayForBill({ billId: relatedBillId, companyId, userId });
      }
    }

    return bill;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const isFullyConverted = async (items, session) => {
  const { GrpoOrder, PurchaseOrder, Bill } = getBooksModels();

  const purchaseOrders = [
    ...new Map(
      items
        .filter(item => item.referenceId && item.referenceType)
        .map(item => [
          `${item.referenceType}:${item.referenceId}`,
          { referenceType: item.referenceType, purchaseOrderId: item.referenceId },
        ]),
    ).values(),
  ];

  if (purchaseOrders.length > 0) {
    //get all item of purchase order with qty
    for (const po of purchaseOrders) {
      const purchaseOrderDoc = await PurchaseOrder.findOne({
        _id: po.purchaseOrderId,
      }).lean();

      if (!purchaseOrderDoc) continue;

      const allItems = purchaseOrderDoc.items.map(item => ({
        purchaseOrderId: po.purchaseOrderId,
        itemId: item.itemId,
        quantity: item.quantity,
      }));

      //now get all items from grpo to check it is converted partially or fully in previous conversion
      const grpoItems = await GrpoOrder.aggregate([
        {
          $match: {
            'purchaseOrders.purchaseOrderId': new mongoose.Types.ObjectId(po.purchaseOrderId),
            'items.referenceId': new mongoose.Types.ObjectId(po.purchaseOrderId),
            status: { $ne: GRPO_STATUSES.CANCELLED },
          },
        },
        {
          $project: {
            matchingItems: {
              $filter: {
                input: '$items',
                as: 'item',
                cond: {
                  $eq: ['$$item.referenceId', new mongoose.Types.ObjectId(po.purchaseOrderId)],
                },
              },
            },
          },
        },
        { $unwind: '$matchingItems' },
        {
          $project: {
            itemId: '$matchingItems.itemId',
            quantity: '$matchingItems.quantity',
            referenceId: '$matchingItems.referenceId',
          },
        },
        {
          $group: {
            _id: {
              itemId: '$itemId',
              referenceId: '$referenceId',
            },
            quantity: { $sum: '$quantity' },
          },
        },
        {
          $project: {
            itemId: '$_id.itemId',
            referenceId: '$_id.referenceId',
            quantity: 1,
            _id: 0,
          },
        },
      ]);

      const billItems = await Bill.aggregate([
        {
          $match: {
            'purchaseOrders.purchaseOrderId': new mongoose.Types.ObjectId(po.purchaseOrderId),
            'items.referenceId': new mongoose.Types.ObjectId(po.purchaseOrderId),
            status: { $ne: GRPO_STATUSES.CANCELLED },
          },
        },
        {
          $project: {
            matchingItems: {
              $filter: {
                input: '$items',
                as: 'item',
                cond: {
                  $eq: ['$$item.referenceId', new mongoose.Types.ObjectId(po.purchaseOrderId)],
                },
              },
            },
          },
        },
        { $unwind: '$matchingItems' },
        {
          $project: {
            itemId: '$matchingItems.itemId',
            quantity: '$matchingItems.quantity',
            referenceId: '$matchingItems.referenceId',
          },
        },
        {
          $group: {
            _id: {
              itemId: '$itemId',
              referenceId: '$referenceId',
            },
            quantity: { $sum: '$quantity' },
          },
        },
        {
          $project: {
            itemId: '$_id.itemId',
            referenceId: '$_id.referenceId',
            quantity: 1,
            _id: 0,
          },
        },
      ]);

      const result = allItems.map(item => {
        const matchedGrpo = grpoItems.find(
          g => g.itemId.toString() === item.itemId.toString() && g.referenceId.toString() === item.purchaseOrderId.toString(),
        );

        const matchedBill = billItems.find(
          b => b.itemId.toString() === item.itemId.toString() && b.referenceId.toString() === item.purchaseOrderId.toString(),
        );

        const deliveredQty = (matchedGrpo?.quantity || 0) + (matchedBill?.quantity || 0);

        return {
          ...item,
          deliveredQuantity: deliveredQty,
          remainingQuantity: item.quantity - deliveredQty,
        };
      });

      const finalResult = result.map(grpoItem => {
        const matchedItem = items.find(
          item =>
            item.itemId.toString() === grpoItem.itemId.toString() &&
            item.referenceId.toString() === grpoItem.purchaseOrderId.toString(),
        );

        const consumedQty = matchedItem ? matchedItem.quantity : 0;

        return {
          ...grpoItem,
          remainingQuantity: grpoItem.remainingQuantity - consumedQty,
        };
      });

      const allRemainingZero = finalResult.every(item => item.remainingQuantity <= 0);

      const statusToUpdate = allRemainingZero ? PO_STATUSES.CONVERTED : PO_STATUSES.PARTIALLY_RECORDED;

      await PurchaseOrder.updateOne(
        { _id: new mongoose.Types.ObjectId(po.purchaseOrderId) },
        { $set: { status: statusToUpdate } },
      ).session(session);
    }
  }
};

const exportBills = async (filter, options, res) => {
  const { Customer, Item, Branch, Division, Warehouse } = getBooksCrmModels();
  const { Bill } = getBooksModels();
  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const conditions = { companyId };

  if (filter?.isSplit == undefined) {
    filter.isSplit = false;
  }

  if (filter?.isSplit) {
    filter.isSplit = true;
  }

  // Date filter
  if (filter.billDate) {
    conditions.billDate = {
      $gte: new Date(filter.billDate),
      $lte: new Date(filter.billDate),
    };
  }

  if (filter.startDate && filter.endDate) {
    conditions.billDate = {
      $gte: new Date(filter.startDate),
      $lte: new Date(filter.endDate),
    };
  }

  // Status filter
  if (filter?.status?.split(',').length > 0) {
    conditions.status = { $in: filter.status.split(',') };
  }

  if (filter.branchId) {
    const branchArray = filter.branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      conditions.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (filter.divisionId) {
    conditions.divisionId = new mongoose.Types.ObjectId(filter.divisionId);
  }

  // Search filter
  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());
    const vendors = await Customer.find(
      {
        companyId,
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    );

    const vendorIds = vendors.map(vendor => vendor._id);
    conditions.$or = [{ grpoNo: searchRegex }, { vendor: { $in: vendorIds } }, { billId: searchRegex }];
  }

  // Get the paginated results and aggregated totals
  const result = await Bill.paginateWithTotal(conditions, options);

  // Populate the line unit (itemUnitId -> ItemUnit name); ItemUnit lives in booksCrm, so pass the model explicitly
  await Bill.populate(result.results, { path: 'items.itemUnitId', select: 'name', model: ItemUnit });

  //Unique vendor and item IDs
  const vendorIds = [...new Set(result.results.map(bill => bill.vendor?.toString()).filter(Boolean))];
  const branchIds = [...new Set(result.results.map(i => i.branchId))];
  const warehouseIds = [...new Set(result.results.map(i => i.warehouseId))];
  const divisionIds = [...new Set(result.results.map(i => i.divisionId))];
  const itemIds = [...new Set(result.results.flatMap(bill => bill.items?.map(item => item.itemId?.toString())).filter(Boolean))];

  // Fetch related data
  const [vendors, items, branch, warehouse, division] = await Promise.all([
    Customer.find({ _id: { $in: vendorIds } })
      .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails')
      .lean(),
    Item.find({ _id: { $in: itemIds } })
      .select('itemName')
      .lean(),
    await Branch.find({
      _id: { $in: branchIds },
    })
      .select('name _id')
      .lean(),
    await Warehouse.find({
      _id: { $in: warehouseIds },
    })
      .select('name _id')
      .lean(),
    await Division.find({
      _id: { $in: divisionIds },
    })
      .select('name _id')
      .lean(),
  ]);

  // Build lookup maps
  const vendorMap = vendors.reduce((acc, vendor) => {
    acc[vendor._id.toString()] = vendor;
    return acc;
  }, {});

  const branchMap = branch.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const divisionMap = division.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const warehouseMap = warehouse.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const itemMap = items.reduce((acc, item) => {
    acc[item._id.toString()] = item;
    return acc;
  }, {});

  // Populate final results
  const populatedResults = result.results.map(bill => {
    const obj = bill.toObject();
    obj.id = obj._id;
    obj.branchId = branchMap[obj.branchId?.toString()] || null;
    obj.divisionId = divisionMap[obj.divisionId?.toString()] || null;
    obj.warehouseId = warehouseMap[obj.warehouseId?.toString()] || null;
    obj.vendor = vendorMap[obj.vendor?.toString()] || null;

    if (Array.isArray(obj.items)) {
      obj.items = obj.items.map(i => ({
        ...i,
        itemId: itemMap[i.itemId?.toString()] || null,
      }));
    }

    return obj;
  });

  const columns = [
    { header: 'Bill ID', key: 'billId', width: 15 },
    { header: 'Customer Name', key: 'customerDisplayName', width: 25 },
    { header: 'Division', key: 'divisionName', width: 20 },
    { header: 'Branch', key: 'branchName', width: 20 },
    { header: 'Warehouse', key: 'warehouseName', width: 20 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Bill Date', key: 'billDate', width: 18 },
    { header: 'Due Date', key: 'dueDate', width: 18 },
    { header: 'Payment Terms', key: 'paymentTermsId', width: 20 },
    { header: 'Basic Amount', key: 'subTotal', width: 15 },
    { header: 'Total', key: 'total', width: 15 },
    { header: 'Paid Amount', key: 'paidAmount', width: 15 },
    { header: 'Balance Amount', key: 'balanceAmount', width: 18 },
    { header: 'Reference', key: 'reference', width: 20 },
    { header: 'Subject', key: 'subject', width: 20 },
    { header: 'Created At', key: 'createdAt', width: 22 },
    { header: 'Updated At', key: 'updatedAt', width: 22 },
  ];

  const STATUS_LABELS = {
    [BILL_STATUSES.DRAFT]: 'Draft',
    [BILL_STATUSES.OPEN]: 'Open',
    [BILL_STATUSES.PAID]: 'Paid',
    [BILL_STATUSES.PARTIALLY_PAID]: 'Partially Paid',
    [BILL_STATUSES.OVERDUE]: 'Overdue',
    [BILL_STATUSES.CANCELLED]: 'Cancelled',
  };
  const transformedBill = billTransformers.queryBill(populatedResults);
  for (let i of transformedBill) {
    i.createdAt = formatDate(i.createdAt);
    i.updatedAt = formatDate(i.updatedAt);
    if (STATUS_LABELS[i.status]) {
      i.status = STATUS_LABELS[i.status];
    }
  }
  await exportToExcel({ data: transformedBill, columns, filename: 'bills-report' }, res);
};

function formatDate(dateString) {
  const date = new Date(dateString);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0'); // months are 0-based
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

const calculateRemainingQty = async (items, id, billId, userId, session) => {
  const { PurchaseOrder } = getBooksModels();

  const purchaseOrders = [
    ...new Map(
      items
        .filter(item => item.referenceId && item.referenceType)
        .map(item => [
          `${item.referenceType}:${item.referenceId}`,
          { referenceType: item.referenceType, purchaseOrderId: item.referenceId },
        ]),
    ).values(),
  ];

  if (purchaseOrders.length > 0) {
    for (const po of purchaseOrders) {
      await PurchaseOrder.updateOne(
        { _id: new mongoose.Types.ObjectId(po.purchaseOrderId) },
        {
          $push: {
            commentHistory: {
              message: `Bill No ${billId} cancelled successfully`,
              addedBy: userId,
              createdAt: new Date(),
            },
          },
        },
        { session },
      );
    }
  }
};

const paymentHistoryForBill = async (billId, companyId) => {
  const { DebitNote, PaymentMade, Bill } = getBooksModels();
  const payments = await PaymentMade.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        'bills.billId': new mongoose.Types.ObjectId(billId),
      },
    },
    {
      $project: {
        _id: 1,
        paymentMadeId: 1,
        paymentDate: 1,
        paymentMode: 1,
        unusedAmount: 1,
        paymentMade: 1,
        status: 1,
        bills: {
          $filter: {
            input: '$bills',
            as: 'inv',
            cond: { $eq: ['$$inv.billId', new mongoose.Types.ObjectId(billId)] },
          },
        },
        openingBalanceTransactions: { $ifNull: ['$openingBalanceTransactions', []] },
      },
    },
  ]);

  const debitNotes = await DebitNote.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        'billsApplied.billId': new mongoose.Types.ObjectId(billId),
      },
    },
    {
      $project: {
        _id: 1,
        debitNoteId: 1,
        debitNoteDate: 1,
        availableBalance: 1,
        total: 1,
        status: 1,
        billsApplied: {
          $filter: {
            input: '$billsApplied',
            as: 'bill',
            cond: { $eq: ['$$bill.billId', new mongoose.Types.ObjectId(billId)] },
          },
        },
      },
    },
  ]);

  const billObjectId = new mongoose.Types.ObjectId(billId);
  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const bill = await Bill.findOne({ _id: billObjectId, companyId: companyObjectId })
    .select('openingBalanceApplications billId vendor')
    .lean();

  if (!bill) {
    return { payments, debitNotes, openingBalanceApplications: [] };
  }

  const docApps = (bill.openingBalanceApplications || []).map(a => ({
    ...a,
    applicationScope: 'bill',
    billNo: bill.billId,
  }));

  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const creditIdSet = new Set(docApps.map(a => a.openingBalanceTransactionId?.toString()).filter(Boolean));
  const creditsLinkedByBillEntry = await OpeningBalanceTransaction.find({
    companyId: companyObjectId,
    contactId: bill.vendor,
    contactType: CONTACT_TYPE.VENDOR,
    type: TRANSACTION_TYPE.VENDOR_CREDIT,
    $or: [{ 'paymentMadeEntries.billId': billObjectId }, ...(bill.billId ? [{ 'paymentMadeEntries.billNo': bill.billId }] : [])],
  })
    .select('_id')
    .lean();
  for (const c of creditsLinkedByBillEntry) {
    creditIdSet.add(String(c._id));
  }

  let obToObApps = [];
  if (creditIdSet.size) {
    const credits = await OpeningBalanceTransaction.find({
      _id: { $in: [...creditIdSet].map(id => new mongoose.Types.ObjectId(id)) },
      companyId: companyObjectId,
    })
      .select('transactionNo paymentMadeEntries')
      .lean();

    for (const credit of credits) {
      for (const e of credit.paymentMadeEntries || []) {
        if (e.billId || !e.paymentDocumentNo) continue;
        if (e.entrySource && e.entrySource !== OB_PAYMENT_ENTRY_SOURCE.BILL_CREDIT) continue;
        // Only OB→OB apps applied from this bill's Apply Credit context
        if (!bill.billId || e.billNo !== bill.billId) continue;
        obToObApps.push({
          _id: e._id,
          openingBalanceTransactionId: credit._id,
          creditTxnId: credit._id,
          transactionNo: credit.transactionNo || `OB-${credit._id}`,
          targetTransactionNo: e.paymentDocumentNo,
          amountApplied: e.amountApplied,
          appliedDate: e.appliedDate,
          type: TRANSACTION_TYPE.VENDOR_CREDIT,
          applicationScope: 'opening_balance',
        });
      }
    }
  }

  const fromPayments = obLinesFromPaymentsMade(payments);
  const merged = [...docApps, ...obToObApps, ...fromPayments].sort(
    (a, b) => new Date(b.appliedDate || 0) - new Date(a.appliedDate || 0),
  );
  const openingBalanceApplications = await enrichObLines(merged, getBooksCrmModels);

  return {
    payments,
    debitNotes,
    openingBalanceApplications,
  };
};

const createSplitBill = async (billBody, userId, uploadedFiles = []) => {
  const { Customer, Branch } = getBooksCrmModels();
  const { Bill } = getBooksModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const { warehouseId, vendor, total, branchId, companyId, items = [], isInventoryEnabled } = billBody;

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: companyId,
    });
    let sourceItems = items;
    let commentHistory = [];

    const company = await Company.findById(companyId).populate('baseCurrency').session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    //give msg if brach do not exist in mention customerid
    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(vendor),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(vendor, branchId, session);
    }

    billBody.billId = await generateUniqueId(
      Bill,
      companyId,
      MODULE_NAMES.SPLIT_BILL,
      'billId',
      'BILL',
      session,
      billBody.billId,
    );

    // Fetch latest inventory config for BILL module
    const inventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.BILL, session);
    if (billBody.customer) {
      // For a customer bill the stock effect comes only from isInventoryEnabled, not from the module config.
      inventoryConfig.stockAddEnabled = Boolean(isInventoryEnabled);
    } else if (isInventoryEnabled) {
      inventoryConfig.stockAddEnabled = true;
    }

    //add default warehouse entry
    if (billBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: billBody.items,
          warehouseId: warehouseId,
          branchId: billBody.branchId,
          divisionId: billBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }

    // Fetch stock details for all requested items
    let bill = {};

    if (commentHistory.length === 0) {
      commentHistory.push({
        message: `Bill created for ${company?.baseCurrency?.symbol || '₹'}${total || 0}`,
        addedBy: userId,
        referenceType: 'BILL',
        createdAt: new Date(),
      });
    }

    const {
      currency,
      exchangeRate: resolvedExchangeRate,
      decimalPlaces,
    } = await resolveTransactionCurrency({
      companyId,
      vendorId: vendor,
    });

    const billData = {
      ...billBody,
      currency,
      exchangeRate: billBody.exchangeRate ?? resolvedExchangeRate ?? 1,
      decimalPlaces,
      attachments: allAttachments,
      authorizedSignature: company?.authorizedSignature,
      items: sourceItems,
      balanceAmount: billBody.total,
      addedBy: userId,
      updatedBy: userId,
      inventoryConfig, // Store the latest config
      isSplit: true,
      commentHistory,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    };

    await validateVendorForModule({
      vendorId: billBody.vendor,
      customerId: billBody.customer,
      addressId: billBody.addressId,
      branchId: billBody.branchId,
      companyId,
      totalAmount: billBody.total,
      moduleName: MODULE_NAMES.SPLIT_BILL,
      session,
      models: { Customer, Branch },
    });

    [bill] = await Bill.create([billData], { session });

    await updateBranchCurrentBalance({
      customerId: vendor,
      branchId,
      amount: total,
      session,
    });

    if (inventoryConfig.stockAddEnabled) {
      const claimBillLine = createLineClaimer(bill.items);
      for (let i of items) {
        // Calculate the final purchase price after discount
        let finalPurchasePrice = i.rate;
        if (i.discountConfig) {
          let discountAmount = 0;
          if (i.discountConfig.discountType === 'PERCENTAGE' && i.discountConfig.discountValue > 0) {
            discountAmount = (i.rate * i.discountConfig.discountValue) / 100;
          } else if (i.discountConfig.discountType === 'AMOUNT' && i.discountConfig.discountValue > 0) {
            // For AMOUNT type, divide by quantity to get per-unit discount
            discountAmount = i.discountConfig.discountValue / i.quantity;
          }
          finalPurchasePrice = i.rate - discountAmount;
        }

        // Store batch cost in base at document exchangeRate so sale COGS matches inventory and cost stays fixed at receipt.
        finalPurchasePrice = Math.round(finalPurchasePrice * (Number(bill?.exchangeRate) || 1) * 100) / 100;

        // Find the corresponding item in the bill and add batch
        const billItem = claimBillLine(i);

        //add warehouseItem Batch
        const warehouseStockObj = {
          action: 'addStock',
          stockData: {
            itemId: i.itemId,
            companyId: bill?.companyId,
            divisionId: bill?.divisionId,
            branchId: bill?.branchId,
            warehouseId,
            quantity: i.quantity,
            itemUnitId: i.itemUnitId,
            purchasePrice: finalPurchasePrice,
            vendorBatchNo: i?.vendorBatchNo,
            vendorBatchExpiry: i?.vendorBatchExpiry,
            sourceType: MODULE_NAMES.SPLIT_BILL,
            sourceId: bill?._id,
            addedBy: userId,
          },
          session,
        };
        const batchSummary = await handleWarehouseStock(warehouseStockObj);

        if (batchSummary && !batchSummary?.skipped) {
          const batchToAdd = {
            batchNo: batchSummary.batchNo,
            quantity: batchSummary.quantity,
            purchasePrice: batchSummary.purchasePrice,
            warehouseId: bill.warehouseId,
            itemBatchId: batchSummary?._id,
          };
          if (billItem) {
            if (!billItem.batches) billItem.batches = [];
            billItem.batches.push(batchToAdd);
          }
        }
      }

      await checkCompanyStockLevels({
        itemIds: items.map(i => i.itemId),
        companyId: bill?.companyId,
        docType: MODULE_NAMES.SPLIT_BILL,
        docId: bill._id,
        docNo: bill.billId,
        userId,
        session,
      });

      // Update the bill with the batches
      await Bill.updateOne({ _id: bill._id }, { $set: { items: bill.items } }, { session });
    }

    if (bill?._id) {
      await syncBillJournal(companyId, bill, userId, session);
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return bill;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const buildModuleTree = async billId => {
  const { Bill, PaymentMade, GrpoOrder, PurchaseOrder } = getBooksModels();

  const moduleTree = { purchaseOrders: [], directBill: null };

  const bill = await Bill.findById(billId).select('_id billId billDate status total grpoIds purchaseOrders');

  if (!bill) return moduleTree;

  /* ================= PAYMENTS ================= */

  const payments = await PaymentMade.find({
    'bills.billId': bill._id,
  }).select('_id paymentMadeId paymentDate status paymentMade');

  const paymentNodes = payments.map(payment => ({
    id: payment._id,
    paymentMadeId: payment.paymentMadeId,
    paymentDate: payment.paymentDate,
    status: payment.status,
    paymentMade: payment.paymentMade,
  }));

  /* ==========================================================
     CASE 1: BILL CREATED FROM GRPO
  ========================================================== */

  if (bill.grpoIds?.length) {
    const grpoIds = bill.grpoIds.map(g => g.grpoId);

    const grpos = await GrpoOrder.find({
      _id: { $in: grpoIds },
    }).select('_id grpoOrderId date status total purchaseOrders');

    for (const grpo of grpos) {
      const poIds = grpo.purchaseOrders?.map(p => p.purchaseOrderId) || [];

      const purchaseOrders = await PurchaseOrder.find({
        _id: { $in: poIds },
      }).select('_id purchaseOrderId date status total');

      for (const po of purchaseOrders) {
        const poNode = {
          id: po._id,
          purchaseOrderId: po.purchaseOrderId,
          date: po.date,
          status: po.status,
          total: po.total,
          grpos: [],
        };

        const grpoNode = {
          id: grpo._id,
          grpoId: grpo.grpoOrderId,
          date: grpo.date,
          status: grpo.status,
          total: grpo.total,
          bills: [],
        };

        const billNode = {
          id: bill._id,
          billId: bill.billId,
          billDate: bill.billDate,
          status: bill.status,
          total: bill.total,
          payments: paymentNodes,
        };

        grpoNode.bills.push(billNode);
        poNode.grpos.push(grpoNode);

        moduleTree.purchaseOrders.push(poNode);
      }
    }

    return moduleTree;
  }

  /* ==========================================================
     CASE 2: BILL CREATED DIRECTLY FROM PURCHASE ORDER
  ========================================================== */

  if (bill.purchaseOrders?.length) {
    const poIds = bill.purchaseOrders.map(p => p.purchaseOrderId);

    const purchaseOrders = await PurchaseOrder.find({
      _id: { $in: poIds },
    }).select('_id purchaseOrderId date status total');

    for (const po of purchaseOrders) {
      const poNode = {
        id: po._id,
        purchaseOrderId: po.purchaseOrderId,
        date: po.date,
        status: po.status,
        total: po.total,
        bills: [],
      };

      poNode.bills.push({
        id: bill._id,
        billId: bill.billId,
        billDate: bill.billDate,
        status: bill.status,
        total: bill.total,
        payments: paymentNodes,
      });

      moduleTree.purchaseOrders.push(poNode);
    }

    return moduleTree;
  }

  /* ==========================================================
     CASE 3: BILL CREATED DIRECTLY (NO PO / NO GRPO)
  ========================================================== */

  moduleTree.directBill = {
    id: bill._id,
    billId: bill.billId,
    billDate: bill.billDate,
    status: bill.status,
    total: bill.total,
    payments: paymentNodes,
  };

  return moduleTree;
};

module.exports = {
  createBill: withTransientRetry(createBill),
  updateBillPaymentStatus,
  cancelBillPayment,
  queryBills,
  queryBillsExports,
  getBillById,
  queryVendorWisePendingBills,
  updateBillById,
  deleteBillById,
  queryPendingBills,
  getBillsForDropdown,
  applyVendorCreditToBill,
  autoMapOpeningBalanceToBills,
  updateBillStatus,
  exportBills,
  paymentHistoryForBill,
  createSplitBill: withTransientRetry(createSplitBill),
  removeOpeningBalanceApplicationFromBill,
  removeOpeningBalanceApplicationFromOb,
};
