const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { PAYMENT_MODES, PAYMENT_STATUS } = require('../../../utils/enum');
const { commonSchemas } = require('../../../validations/common.validation');

const createPaymentMade = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    paymentMadeId: Joi.string(),
    vendorId: Joi.string().required().custom(objectId).label('Vendor').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
    paymentDate: Joi.date().required().label('Payment Date').messages({
      'any.required': '{{#label}} is required',
      'date.base': '{{#label}} must be a valid date',
    }),
    chequeNo: Joi.string().optional().allow(null, '').label('Cheque No').messages({
      'date.base': '{{#label}} must be a string',
    }),
    pdcChequeDate: Joi.date().optional().allow(null, '').label('PDC Cheque Date').messages({
      'date.base': '{{#label}} must be a valid date',
    }),
    paymentMode: Joi.string()
      .required()
      .valid(...Object.values(PAYMENT_MODES))
      .label('Payment Mode')
      .messages({
        'any.required': '{{#label}} is required',
        'any.invalid': '{{#label}} must be one of the valid payment modes',
      }),
    paidThroughAccountId: Joi.string().custom(objectId).required().label('Paid Through Account').messages({
      'any.required': '{{#label}} is required',
    }),

    paymentMade: Joi.number().required().min(0).label('Payment Made').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.min': '{{#label}} must be greater than or equal to 0',
    }),
    reference: Joi.string().allow('').label('Reference').messages({
      'string.empty': '{{#label}} cannot be empty',
    }),
    status: Joi.string()
      .valid(...Object.values(PAYMENT_STATUS))
      .label('Status')
      .messages({
        'any.invalid': '{{#label}} must be one of the valid statuses',
      }),
    isAdvancePayment: Joi.boolean().default(false).label('Is Advance Payment'),
    bills: Joi.array().items(
      Joi.object({
        billId: Joi.string().required().custom(objectId).label('Bill ID').messages({
          'any.required': '{{#label}} is required',
          'string.base': '{{#label}} must be a string',
        }),
        billNo: Joi.string().required().label('Bill No').messages({
          'any.required': '{{#label}} is required',
          'string.base': '{{#label}} must be a string',
        }),
        amountApplied: Joi.number().required().label('Amount Applied').messages({
          'any.required': '{{#label}} is required',
          'number.base': '{{#label}} must be a number',
        }),
      }),
    ),
    openingBalanceTransactions: Joi.array()
      .items(
        Joi.object({
          openingBalanceTransactionId: Joi.string().required().custom(objectId).label('Opening Balance Transaction ID'),
          transactionNo: Joi.string().optional().allow('', null),
          amountApplied: Joi.number().required().min(0).label('Amount Applied'),
        }),
      )
      .label('Opening Balance Transactions'),
    expenses: Joi.array()
      .items(
        Joi.object({
          expenseId: Joi.string().required().custom(objectId).label('Expense ID').messages({
            'any.required': '{{#label}} is required',
            'string.base': '{{#label}} must be a string',
          }),
          expenseNo: Joi.string().required().label('Expense No').messages({
            'any.required': '{{#label}} is required',
            'string.base': '{{#label}} must be a string',
          }),
          amountApplied: Joi.number().required().greater(0).label('Amount Applied').messages({
            'any.required': '{{#label}} is required',
            'number.base': '{{#label}} must be a number',
            'number.greater': '{{#label}} must be greater than 0',
          }),
        }),
      )
      .label('Expenses'),
    notes: Joi.string().allow('').label('Notes').messages({
      'string.empty': '{{#label}} cannot be empty',
    }),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    warehouseId: Joi.string().optional().allow('', null).custom(objectId).label('Warehouse ID').messages({
      'string.base': '{{#label}} must be a string',
    }),
    branchId: Joi.string().optional().allow('', null).custom(objectId).label('Warehouse ID').messages({
      'string.base': '{{#label}} must be a string',
    }),
    divisionId: Joi.string().optional().allow('', null).custom(objectId).label('Warehouse ID').messages({
      'string.base': '{{#label}} must be a string',
    }),
    isSplit: Joi.boolean().optional().allow(null),
    allowCrossBranchMapping: Joi.boolean().optional().default(false).label('Allow Cross Branch Mapping'),
    exchangeRate: Joi.number().min(0).allow(null).optional().label('Exchange Rate'),
  }),
};

const getPaymentMades = {
  query: Joi.object().keys({
    paymentMadeId: Joi.string(),
    companyId: Joi.string().custom(objectId).required(),
    customerId: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    status: Joi.string(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    paymentDate: Joi.date(),
    paidThroughAccountId: Joi.string().custom(objectId).optional().allow(null),
    isSplit: Joi.boolean().optional().allow(null),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    paymentMode: Joi.string(),
    isPendingMapping: Joi.boolean().optional().allow(null),
    addedBy: Joi.string(),
  }),
};

const getPaymentMadesExports = {
  query: Joi.object().keys({
    paymentMadeId: Joi.string(),
    companyId: Joi.string().custom(objectId).required(),
    customerId: Joi.string(),
    country: Joi.string().allow(''),
    state: Joi.string().allow(''),
    city: Joi.string().allow(''),
    status: Joi.string(),
    sortBy: Joi.string(),
    search: Joi.string(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    paymentDate: Joi.date(),
    paidThroughAccountId: Joi.string().custom(objectId).optional().allow(null),
    isSplit: Joi.boolean().optional().allow(null),
    branchId: Joi.string(),
    divisionId: Joi.string(),
    paymentMode: Joi.string(),
    isPendingMapping: Joi.boolean().optional().allow(null),
    addedBy: Joi.string(),
  }),
};
const getPaymentMade = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    paymentMadeId: Joi.string().custom(objectId),
  }),
};

const updatePaymentMade = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    paymentMadeId: Joi.required().custom(objectId).label('Payment Made ID').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
  }),
  body: Joi.object()
    .keys({
      paymentDate: Joi.date().label('Payment Date').messages({
        'date.base': '{{#label}} must be a valid date',
      }),
      vendorId: Joi.string().custom(objectId).required().label('Vendor ID').messages({
        'any.required': '{{#label}} is required',
        'string.base': '{{#label}} must be a string',
      }),
      paymentMode: Joi.string()
        .valid(...Object.values(PAYMENT_MODES))
        .label('Payment Mode')
        .messages({
          'any.invalid': '{{#label}} must be one of the valid payment modes',
        }),
      paidThroughAccountId: Joi.string().custom(objectId).optional().label('Paid Through Account'),

      chequeNo: Joi.string().optional().allow(null, '').label('Cheque No').messages({
        'date.base': '{{#label}} must be a string',
      }),
      pdcChequeDate: Joi.date().optional().allow(null, '').label('PDC Cheque Date').messages({
        'date.base': '{{#label}} must be a valid date',
      }),
      paymentMade: Joi.number().min(0).label('Payment Made').messages({
        'number.base': '{{#label}} must be a number',
        'number.min': '{{#label}} must be greater than or equal to 0',
      }),
      reference: Joi.string().allow('').label('Reference').messages({
        'string.empty': '{{#label}} cannot be empty',
      }),
      status: Joi.string()
        .valid(...Object.values(PAYMENT_STATUS))
        .label('Status')
        .messages({
          'any.invalid': '{{#label}} must be one of the valid statuses',
        }),
      isAdvancePayment: Joi.boolean().optional().label('Is Advance Payment'),
      bills: Joi.array()
        .items(
          Joi.object({
            billId: Joi.string().required().custom(objectId).label('Bill ID').messages({
              'any.required': '{{#label}} is required',
              'string.base': '{{#label}} must be a string',
            }),
            billNo: Joi.string().required().label('Bill No').messages({
              'any.required': '{{#label}} is required',
              'string.base': '{{#label}} must be a string',
            }),
            amountApplied: Joi.number().required().label('Amount Applied').messages({
              'any.required': '{{#label}} is required',
              'number.base': '{{#label}} must be a number',
            }),
          }),
        )
        .label('Bills'),
      openingBalanceTransactions: Joi.array()
        .optional()
        .items(
          Joi.object({
            openingBalanceTransactionId: Joi.string().required().custom(objectId).label('Opening Balance Transaction ID'),
            transactionNo: Joi.string().optional().allow('', null),
            amountApplied: Joi.number().required().min(0).label('Amount Applied'),
          }),
        )
        .label('Opening Balance Transactions'),
      expenses: Joi.array()
        .items(
          Joi.object({
            expenseId: Joi.string().required().custom(objectId).label('Expense ID').messages({
              'any.required': '{{#label}} is required',
              'string.base': '{{#label}} must be a string',
            }),
            expenseNo: Joi.string().required().label('Expense No').messages({
              'any.required': '{{#label}} is required',
              'string.base': '{{#label}} must be a string',
            }),
            amountApplied: Joi.number().required().greater(0).label('Amount Applied').messages({
              'any.required': '{{#label}} is required',
              'number.base': '{{#label}} must be a number',
              'number.greater': '{{#label}} must be greater than 0',
            }),
          }),
        )
        .label('Expenses'),
      notes: Joi.string().allow('').label('Notes').messages({
        'string.empty': '{{#label}} cannot be empty',
      }),
      attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
        'array.base': '{{#label}} must be an array of strings',
      }),
      warehouseId: Joi.string().optional().allow('', null).custom(objectId).label('Warehouse ID').messages({
        'string.base': '{{#label}} must be a string',
      }),
      branchId: Joi.string().optional().allow('', null).custom(objectId).label('Warehouse ID').messages({
        'string.base': '{{#label}} must be a string',
      }),
      divisionId: Joi.string().optional().allow('', null).custom(objectId).label('Warehouse ID').messages({
        'string.base': '{{#label}} must be a string',
      }),
      isChequePayment: Joi.boolean().optional().allow(null),
      isSplit: Joi.boolean().optional().allow(null),
      allowCrossBranchMapping: Joi.boolean().optional().label('Allow Cross Branch Mapping'),
      exchangeRate: Joi.number().min(0).allow(null).optional().label('Exchange Rate'),
    })
    .min(1),
};

const deletePaymentMade = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    paymentMadeId: Joi.string().custom(objectId),
  }),
};

const approveStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    paymentMadeId: Joi.string().custom(objectId),
  }),
  body: Joi.object().keys({
    approvalNote: Joi.string().allow('', null),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    pdcChequeDate: Joi.date().allow('', null),
    chequeApprovalNote: Joi.string().allow('', null),
  }),
};

const rejectStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    paymentMadeId: Joi.string().custom(objectId),
  }),
  body: Joi.object().keys({
    notes: Joi.string().allow('', null),
    approvalNote: Joi.string().allow('', null),
    attachments: Joi.array().items(Joi.string()).label('Attachments').messages({
      'array.base': '{{#label}} must be an array of strings',
    }),
    pdcChequeDate: Joi.date().allow('', null),
    chequeApprovalNote: Joi.string().allow('', null),
  }),
};

const cancelStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    paymentMadeId: Joi.string().custom(objectId),
  }),
  body: Joi.object().keys({
    notes: Joi.string().allow('', null),
  }),
};

const deletePaymentMadeBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    paymentMadeId: Joi.string().custom(objectId),
  }),
  body: Joi.object().keys({
    bills: Joi.array()
      .items(
        Joi.object({
          billId: Joi.string().required().custom(objectId).label('Bill ID').messages({
            'any.required': '{{#label}} is required',
            'string.base': '{{#label}} must be a string',
          }),
          billNo: Joi.string().required().label('Bill No').messages({
            'any.required': '{{#label}} is required',
            'string.base': '{{#label}} must be a string',
          }),
          amountApplied: Joi.number().required().label('Amount Applied').messages({
            'any.required': '{{#label}} is required',
            'number.base': '{{#label}} must be a number',
          }),
        }),
      )
      .label('Bills'),
    expenses: Joi.array()
      .items(
        Joi.object({
          expenseId: Joi.string().required().custom(objectId).label('Expense ID').messages({
            'any.required': '{{#label}} is required',
            'string.base': '{{#label}} must be a string',
          }),
          expenseNo: Joi.string().required().label('Expense No').messages({
            'any.required': '{{#label}} is required',
            'string.base': '{{#label}} must be a string',
          }),
          amountApplied: Joi.number().required().greater(0).label('Amount Applied').messages({
            'any.required': '{{#label}} is required',
            'number.base': '{{#label}} must be a number',
            'number.greater': '{{#label}} must be greater than 0',
          }),
        }),
      )
      .label('Expenses'),
  }),
};

const applyAdvancePaymentMadeAgainstBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    paymentMadeId: commonSchemas.objectId({ label: 'Payment Made ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    bills: Joi.array()
      .items(
        Joi.object({
          billId: commonSchemas.objectId({ label: 'Bill ID', isRequired: true }),
          billNo: commonSchemas.string({ label: 'Bill No', isRequired: true }),
          amountApplied: commonSchemas.number({ label: 'Amount Applied', isRequired: true }),
        }),
      )
      .label('Bills'),
    openingBalanceTransactions: Joi.array()
      .items(
        Joi.object({
          openingBalanceTransactionId: commonSchemas.objectId({ label: 'Opening Balance Transaction ID', isRequired: true }),
          transactionNo: commonSchemas.string({ label: 'Transaction No', isRequired: false }),
          amountApplied: commonSchemas.number({ label: 'Amount Applied', isRequired: true }),
        }),
      )
      .label('Opening Balance Transactions'),
    expenses: Joi.array()
      .items(
        Joi.object({
          expenseId: Joi.string().required().custom(objectId).label('Expense ID').messages({
            'any.required': '{{#label}} is required',
            'string.base': '{{#label}} must be a string',
          }),
          expenseNo: Joi.string().required().label('Expense No').messages({
            'any.required': '{{#label}} is required',
            'string.base': '{{#label}} must be a string',
          }),
          amountApplied: Joi.number().required().greater(0).label('Amount Applied').messages({
            'any.required': '{{#label}} is required',
            'number.base': '{{#label}} must be a number',
            'number.greater': '{{#label}} must be greater than 0',
          }),
        }),
      )
      .label('Expenses'),
  }),
};

const removeAdvancePaymentMadeAgainstBill = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    paymentMadeId: commonSchemas.objectId({ label: 'Payment Made ID', isRequired: true }),
  }),
  body: Joi.object()
    .keys({
      billId: commonSchemas.objectId({ label: 'Bill line ID', isRequired: false }),
      openingBalanceLineId: commonSchemas.objectId({
        label: 'Opening balance line ID',
        isRequired: false,
      }),
      expenseLineId: commonSchemas.objectId({ label: 'Expense line ID', isRequired: false }),
    })
    .xor('billId', 'openingBalanceLineId', 'expenseLineId'),
};

const autoApplyPendingAdvancePaymentMade = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    customerId: Joi.string()
      .optional()
      .allow('', null)
      .custom((value, helpers) => {
        if (!value) {
          return value;
        }
        return objectId(value, helpers);
      })
      .label('Vendor ID'),
  }),
};

const addRefund = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({}),
  body: Joi.object().keys({
    paymentMadeId: Joi.string().required().custom(objectId).label('PaymentMadeId'),
    refundedAt: Joi.date().required().label('Refund date').messages({
      'any.required': '{{#label}} is required',
      'date.base': '{{#label}} must be a valid date',
    }),
    paymentMode: Joi.string()
      .required()
      .valid(...Object.values(PAYMENT_MODES))
      .label('Payment Mode')
      .messages({
        'any.required': '{{#label}} is required',
        'any.invalid': '{{#label}} must be one of the valid payment modes',
      }),
    toAccountId: Joi.string().custom(objectId).required().label('To Account'),
    amountRefunded: Joi.number().required().min(0).label('Amount Refunded').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.min': '{{#label}} must be greater than or equal to 0',
    }),
    description: Joi.string().required().label('Reason').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
  }),
};

const deleteRefund = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    paymentMadeId: Joi.string().required().custom(objectId).label('PaymentMadeId'),
    refundId: Joi.string().required().custom(objectId).label('Refund ID'),
  }),
};

const updateRefund = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    paymentMadeId: Joi.string().required().custom(objectId).label('PaymentMadeId'),
  }),
  body: Joi.object().keys({
    refundId: Joi.string().required().custom(objectId).label('Refund ID'),
    refundedAt: Joi.date().required().label('Refund date').messages({
      'any.required': '{{#label}} is required',
      'date.base': '{{#label}} must be a valid date',
    }),
    paymentMode: Joi.string()
      .optional()
      .allow(null, '')
      .valid(...Object.values(PAYMENT_MODES))
      .label('Payment Mode')
      .messages({
        'any.required': '{{#label}} is required',
        'any.invalid': '{{#label}} must be one of the valid payment modes',
      }),
    toAccountId: Joi.string().custom(objectId).optional().label('To Account'),
    amountRefunded: Joi.number().required().min(0).label('Amount Refunded').messages({
      'any.required': '{{#label}} is required',
      'number.base': '{{#label}} must be a number',
      'number.min': '{{#label}} must be greater than or equal to 0',
    }),
    description: Joi.string().required().label('Reason').messages({
      'any.required': '{{#label}} is required',
      'string.base': '{{#label}} must be a string',
    }),
  }),
};

module.exports = {
  createPaymentMade,
  getPaymentMades,
  getPaymentMadesExports,
  getPaymentMade,
  updatePaymentMade,
  deletePaymentMade,
  approveStatus,
  rejectStatus,
  cancelStatus,
  deletePaymentMadeBill,
  applyAdvancePaymentMadeAgainstBill,
  removeAdvancePaymentMadeAgainstBill,
  autoApplyPendingAdvancePaymentMade,
  addRefund,
  deleteRefund,
  updateRefund,
};
