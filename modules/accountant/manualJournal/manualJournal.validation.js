const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { CURRENCIES, REPORTING_METHODS } = require('../../../utils/enum');

const journalEntrySchema = isEdit =>
  Joi.object({
    ...(isEdit
      ? {
          _id: Joi.string().optional().custom(objectId).label('Journal Entry ID').messages({
            'any.required': '{{#label}} is required',
          }),
        }
      : {}),
    accountId: Joi.string().required().custom(objectId).label('Account ID').messages({
      'any.required': '{{#label}} is required',
    }),
    businessAccountLedgerMasterId: Joi.string().optional().allow(null, '').custom(objectId).label('Contact'),
    description: Joi.string().allow(null, '').optional().trim().label('Description'),
    debits: Joi.number().positive().empty(['', null]).optional().label('Debits').messages({
      'number.base': 'Please enter a valid amount as Debit or Credit',
      'number.positive': 'Please enter a valid amount as Debit or Credit',
    }),
    credits: Joi.number().positive().empty(['', null]).optional().label('Credits').messages({
      'number.base': 'Please enter a valid amount as Debit or Credit',
      'number.positive': 'Please enter a valid amount as Debit or Credit',
    }),
  })
    .xor('debits', 'credits')
    .messages({
      'object.xor': 'Each journal entry must have either Debits or Credits (but not both).',
      'object.missing': 'Please enter a valid amount as Debit or Credit',
    });

const createManualJournal = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    manualJournalId: Joi.string().required().label('Manual Journal ID'),
    divisionId: Joi.string().required().custom(objectId).label('Division ID'),
    branchId: Joi.string().required().custom(objectId).label('Branch ID'),
    warehouseId: Joi.string().optional().allow(null, '').custom(objectId).label('Warehouse ID'),
    date: Joi.date().required().label('Date'),
    reference: Joi.string().allow(null, '').optional().label('Reference'),
    notes: Joi.string().required().label('Notes'),
    currency: Joi.string()
      .valid(...Object.values(CURRENCIES))
      .required()
      .label('Currency'),
    reportingMethod: Joi.string()
      .valid(...Object.values(REPORTING_METHODS))
      .default(REPORTING_METHODS.ACCURAL_AND_CASH)
      .label('Reporting Method'),
    journalEntries: Joi.array().items(journalEntrySchema(false)).min(1).required().label('Journal Entries'),
    attachments: Joi.array().items(Joi.string().trim()).optional().label('Attachments'),
  }),
};

const getManualJournals = {
  query: Joi.object().keys({
    date: Joi.date().optional().label('Date'),
    startDate: Joi.date().optional().label('Start Date'),
    endDate: Joi.date().optional().label('End Date'),
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
    divisionId: Joi.string().optional().custom(objectId).label('Division ID'),
    branchId: Joi.string(),
    warehouseId: Joi.string().optional().custom(objectId).label('Warehouse ID'),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    search: Joi.string(),
  }),
};

const getManualJournal = {
  params: Joi.object().keys({
    manualJournalId: Joi.string().required().custom(objectId).label('Manual Journal ID'),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
};

const updateManualJournal = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
  params: Joi.object().keys({
    manualJournalId: Joi.string().required().custom(objectId).label('Manual Journal ID'),
  }),
  body: Joi.object()
    .keys({
      manualJournalId: Joi.string().optional().label('Manual Journal ID'),
      divisionId: Joi.string().optional().custom(objectId).label('Division ID'),
      branchId: Joi.string().optional().custom(objectId).label('Branch ID'),
      warehouseId: Joi.string().optional().allow(null, '').custom(objectId).label('Warehouse ID'),
      date: Joi.date().optional().label('Date'),
      reference: Joi.string().allow(null, '').optional().label('Reference'),
      notes: Joi.string().optional().label('Notes'),
      currency: Joi.string()
        .valid(...Object.values(CURRENCIES))
        .optional()
        .label('Currency'),
      reportingMethod: Joi.string()
        .valid(...Object.values(REPORTING_METHODS))
        .optional()
        .label('Reporting Method'),
      journalEntries: Joi.array().items(journalEntrySchema(true)).min(1).optional().label('Journal Entries'),
      attachments: Joi.array().items(Joi.string().trim()).optional().label('Attachments'),
    })
    .min(1)
    .label('Update Body')
    .messages({
      'object.min': 'At least one field must be provided for updating the manual journal',
    }),
};

const deleteManualJournal = {
  params: Joi.object().keys({
    manualJournalId: Joi.string().required().custom(objectId).label('Manual Journal ID'),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
  }),
};

const getContactDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
    branchId: Joi.string().required().custom(objectId).label('Branch ID'),
  }),
};

module.exports = {
  createManualJournal,
  getManualJournals,
  getManualJournal,
  updateManualJournal,
  deleteManualJournal,
  getContactDropdown,
};
