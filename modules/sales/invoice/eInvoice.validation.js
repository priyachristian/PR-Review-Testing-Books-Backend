const Joi = require('joi');

const stateCodeMatchesGstin = label => (value, helpers) => {
  const gstin = value?.gstin;
  const stcd = value?.stcd;
  if (!gstin || gstin === 'URP' || !stcd) return value;
  const gstinStateCode = String(gstin).slice(0, 2);
  if (gstinStateCode !== String(stcd)) {
    return helpers.message(
      `${label} state code (${stcd}) does not match the GSTIN state code (${gstinStateCode}). Please correct the address/state.`,
    );
  }
  return value;
};

const eInvoiceSchema = Joi.object({
  action: Joi.string().valid('GENERATEIRN', 'CANCELIRN', 'GENERATEEWB').required().description('Action type for NIC API'),

  data: Joi.object({
    version: Joi.string().valid('1.1', '1.01').required(),

    tranDtls: Joi.object({
      taxSch: Joi.string().valid('GST').min(3).max(10).required(),
      supTyp: Joi.string().valid('B2B', 'SEZWP', 'SEZWOP', 'EXPWP', 'EXPWOP', 'DEXP').min(3).max(10).required(),
      regRev: Joi.string().valid('Y', 'N').min(1).max(1).required(),
      igstOnIntra: Joi.string().valid('Y', 'N').min(1).max(1),
    }).required(),

    docDtls: Joi.object({
      typ: Joi.string().valid('INV', 'CRN', 'DBN').min(3).max(3).required(),
      no: Joi.string().min(1).max(15).required().label('Invoice Number').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      dt: Joi.string()
        .pattern(/^\d{2}\/\d{2}\/\d{4}$/)
        .min(10)
        .max(10)
        .required(),
    }).required(),

    sellerDtls: Joi.object({
      gstin: Joi.string().length(15).required().label('Seller GSTIN').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      lglNm: Joi.string().required().min(3).max(100).label('Seller Legal Name').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      trdNm: Joi.string().min(3).max(100).label('Seller Trade Name').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      addr1: Joi.string().required().min(1).max(100).label('Seller Address Line 1').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      addr2: Joi.string().required().min(3).max(100).label('Seller Address Line 2').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      loc: Joi.string().required().min(3).max(50).label('Seller Location').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      pin: Joi.number().min(100000).max(999999).required().label('Seller Pin Code').messages({
        'number.base': '{{#label}} must be a number',
        'number.min': '{{#label}} must be greater than or equal to 100000',
        'number.max': '{{#label}} must be less than or equal to 999999',
        'any.required': 'Please add {{#label}}',
      }),
      stcd: Joi.string().min(1).max(2).required().label('Seller State Code').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      ph: Joi.string().min(6).max(12).label('Seller Phone Number').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      em: Joi.string().email().min(6).max(100).label('Seller Email').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
    })
      .required()
      .custom(stateCodeMatchesGstin('Seller')),

    buyerDtls: Joi.object({
      gstin: Joi.string().required().min(3).max(15).label('Customer GSTIN').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      lglNm: Joi.string().required().min(3).max(100).label('Customer Legal Name').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      trdNm: Joi.string().min(3).max(100).label('Customer Trade Name').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      pos: Joi.string().length(2).required().min(1).max(2).label('Customer POS Code').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      addr1: Joi.string().required().min(1).max(100).label('Customer Address Line 1').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      addr2: Joi.string().optional().min(3).max(100).label('Customer Address Line 2').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      loc: Joi.string().required().min(3).max(100).label('Customer Location').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      pin: Joi.number().min(100000).max(999999).required().label('Customer Pin Code').messages({
        'number.base': '{{#label}} must be a number',
        'number.min': '{{#label}} must be greater than or equal to 100000',
        'number.max': '{{#label}} must be less than or equal to 999999',
        'any.required': 'Please add {{#label}}',
      }),
      stcd: Joi.string().required().min(1).max(2).label('Customer State Code').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      ph: Joi.string().min(6).max(12).label('Customer Phone Number').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      em: Joi.string().email().min(6).max(100).label('Customer Email').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
    })
      .required()
      .custom(stateCodeMatchesGstin('Customer')),

    dispDtls: Joi.object({
      nm: Joi.string().required().min(3).max(100).label('Seller Name'),
      addr1: Joi.string().required().min(1).max(100).label('Seller Address Line 1').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      addr2: Joi.string().optional().min(3).max(100).label('Seller Address Line 2').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      loc: Joi.string().required().min(3).max(100).label('Seller Location').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      pin: Joi.number().min(100000).max(999999).required().label('Seller Pin Code').messages({
        'number.base': '{{#label}} must be a number',
        'number.min': '{{#label}} must be greater than or equal to 100000',
        'number.max': '{{#label}} must be less than or equal to 999999',
        'any.required': 'Please add {{#label}}',
        'number.empty': 'Please add {{#label}}',
      }),
      stcd: Joi.string().min(1).max(2).required().label('Seller State Code').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
    }).optional(),

    shipDtls: Joi.object({
      gstin: Joi.string().min(3).max(15).label('Shipper GSTIN').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      lglNm: Joi.string().required().min(3).max(100).label('Shipper Legal Name').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      trdNm: Joi.string().min(3).max(100).label('Shipper Trade Name').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      addr1: Joi.string().required().min(1).max(100).label('Customer Address Line 1').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      addr2: Joi.string().optional().allow('').min(3).max(100).label('Customer Address Line 2').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      loc: Joi.string().required().min(3).max(100).label('Customer Location').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
      pin: Joi.number().min(100000).max(999999).required().label('Customer Pin Code').messages({
        'number.base': '{{#label}} must be a number',
        'number.min': '{{#label}} must be greater than or equal to 100000',
        'number.max': '{{#label}} must be less than or equal to 999999',
        'any.required': 'Please add {{#label}}',
      }),
      stcd: Joi.string().min(1).max(2).required().label('Customer State Code').messages({
        'string.base': '{{#label}} must be a string',
        'string.empty': 'Please add {{#label}}',
        'any.required': 'Please add {{#label}}',
      }),
    })
      .optional()
      .custom(stateCodeMatchesGstin('Shipper')),

    itemList: Joi.array()
      .items(
        Joi.object({
          slNo: Joi.string().required().min(1).max(6),
          prdDesc: Joi.string().required().min(3).max(300),
          isServc: Joi.string().valid('Y', 'N').required().min(1).max(1),
          hsnCd: Joi.string().required().min(4).max(8),
          qty: Joi.number().required().min(0).max(9999999999.999),
          unit: Joi.string().min(3).max(8).required().label('Item Unit').messages({
            'string.min': 'Item unit "{{#value}}" must be 3 to 8 characters. Update the item unit and try again.',
            'string.max': 'Item unit "{{#value}}" must be 3 to 8 characters. Update the item unit and try again.',
            'string.empty': 'Please add {{#label}}',
            'any.required': 'Please add {{#label}}',
          }),
          unitPrice: Joi.number().min(0).max(999999999999.999).required(),
          totAmt: Joi.number().min(0).max(999999999999.99).required(),
          discount: Joi.number().min(0).max(999999999999.99).default(0),
          preTaxVal: Joi.number().min(0).max(999999999999.99).default(0),
          assAmt: Joi.number().min(0).max(999999999999.99).required(),
          gstRt: Joi.number().min(0).max(999.999).required(),
          igstAmt: Joi.number().min(0).max(999999999999.99).required(),
          cgstAmt: Joi.number().min(0).max(999999999999.99).required(),
          sgstAmt: Joi.number().min(0).max(999999999999.99).required(),
          totItemVal: Joi.number().min(0).max(999999999999.99).required(),
        }),
      )
      .min(1)
      .required(),

    valDtls: Joi.object({
      assVal: Joi.number().min(0).max(99999999999999.99).required(),
      cgstVal: Joi.number().min(0).max(99999999999999.99).required(),
      sgstVal: Joi.number().min(0).max(99999999999999.99).required(),
      igstVal: Joi.number().min(0).max(99999999999999.99).required(),
      cesVal: Joi.number().min(0).max(99999999999999.99).default(0),
      stCesVal: Joi.number().min(0).max(99999999999999.99).default(0),
      Discount: Joi.number().min(0).max(99999999999999.99).default(0),
      othChrg: Joi.number().min(0).max(99999999999999.99).default(0),
      rndOffAmt: Joi.number().default(0).min(-99.99).max(99.99),
      totInvVal: Joi.number().min(0).max(99999999999999.99).required(),
    }).required(),

    ewbDtls: Joi.object({
      TransMode: Joi.string().valid('1', '2', '3', '4').optional().min(1).max(1).label('Transport Mode'),
      TransId: Joi.when('TransMode', {
        is: Joi.exist(),
        then: Joi.string()
          .optional()
          .min(15)
          .max(15)
          .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/)
          .label('Transporter GSTIN')
          .messages({
            'string.pattern.base': 'Invalid GSTIN format. Please enter a valid 15-character GSTIN (e.g., 27AABCM8432E1ZL).',
          }),
        otherwise: Joi.string()
          .required()
          .min(15)
          .max(15)
          .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/)
          .label('Transporter GSTIN (required when Transport Mode not provided)')
          .messages({
            'any.required': 'Transporter GSTIN is required when Transport Mode is not provided.',
            'string.pattern.base': 'Invalid GSTIN format. Please enter a valid 15-character GSTIN (e.g., 27AABCM8432E1ZL).',
          }),
      }),

      TransName: Joi.string().optional().min(3).max(100).label('Transporter Name'),
      Distance: Joi.number().min(0).max(4000).required().label('Distance (KM)'),
      transDocNo: Joi.string().min(1).max(15).optional().label('Transport Document Number'),
      transDocDt: Joi.string()
        .pattern(/^\d{2}\/\d{2}\/\d{4}$/)
        .min(10)
        .max(10)
        .required()
        .label('Transport Document Date (DD/MM/YYYY)'),

      // Mode 1 → Road
      VehNo: Joi.when('TransMode', {
        is: '1',
        then: Joi.string()
          .pattern(/^[A-Z]{2}\d{1,2}[A-Z]{1,2}\d{1,4}$/)
          .required()
          .min(4)
          .max(20)
          .label('Vehicle Number (Road)'),
        otherwise: Joi.string().optional().min(4).max(20),
      }),

      VehType: Joi.when('TransMode', {
        is: '1',
        then: Joi.string().valid('R', 'O').required().label('Vehicle Type (Road)').min(1).max(1),
        otherwise: Joi.string().optional().min(1).max(1),
      }),

      // Mode 2 → Rail
      RRNo: Joi.when('TransMode', {
        is: '2',
        then: Joi.string()
          .pattern(/^[A-Za-z0-9/-]{1,20}$/)
          .required()
          .label('Railway Receipt (RR) Number'),
        otherwise: Joi.string().optional(),
      }),

      RRDate: Joi.when('TransMode', {
        is: '2',
        then: Joi.string()
          .pattern(/^\d{2}\/\d{2}\/\d{4}$/)
          .required()
          .label('RR Date (DD/MM/YYYY)'),
        otherwise: Joi.string().optional(),
      }),

      // Mode 3 → Air
      AWBNo: Joi.when('TransMode', {
        is: '3',
        then: Joi.string()
          .pattern(/^[A-Za-z0-9/-]{1,20}$/)
          .required()
          .label('Airway Bill (AWB) Number'),
        otherwise: Joi.string().optional(),
      }),

      AWBDate: Joi.when('TransMode', {
        is: '3',
        then: Joi.string()
          .pattern(/^\d{2}\/\d{2}\/\d{4}$/)
          .required()
          .label('AWB Date (DD/MM/YYYY)'),
        otherwise: Joi.string().optional(),
      }),

      // Mode 4 → Ship
      BLNo: Joi.when('TransMode', {
        is: '4',
        then: Joi.string()
          .pattern(/^[A-Za-z0-9/-]{1,20}$/)
          .required()
          .label('Bill of Lading (BL) Number'),
        otherwise: Joi.string().optional(),
      }),

      BLDate: Joi.when('TransMode', {
        is: '4',
        then: Joi.string()
          .pattern(/^\d{2}\/\d{2}\/\d{4}$/)
          .required()
          .label('BL Date (DD/MM/YYYY)'),
        otherwise: Joi.string().optional(),
      }),
    })
      .custom((value, helpers) => {
        const hasTransportMode = !!value?.TransMode;
        const hasTransporterDetails = value?.TransId && value?.TransName;

        if (!hasTransportMode && !hasTransporterDetails) {
          return helpers.error('any.custom', 'Either Transport Mode or both Transporter ID & Transporter Name are required.');
        }
      })
      .optional()
      .label('E-Way Bill Details'),
  }).required(),
});

const generateOnlyEWayBillSchema = Joi.object({
  action: Joi.string().valid('GENEWAYBILL').required(),
  data: Joi.object({
    supplyType: Joi.string().valid('O', 'I').min(1).max(1).required(),
    subSupplyType: Joi.string().required(),
    subSupplyDesc: Joi.string().max(20).optional(),
    docType: Joi.string().valid('INV', 'CHL', 'BIL', 'BOE', 'CNT', 'OTH').required(),
    docNo: Joi.string().max(15).required(),
    docDate: Joi.string()
      .pattern(/^[0-3][0-9]\/[0-1][0-9]\/[2][0][1-2][0-9]$/)
      .required(),
    fromGstin: Joi.string()
      .custom((value, helpers) => {
        if (value === 'URP') return value;
        if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(value)) {
          return helpers.error('string.pattern.base');
        }
        return value;
      })
      .required()
      .label("Seller's GSTIN"),
    fromTrdName: Joi.string().max(100).optional().label("Seller's Trading Name"),
    fromAddr1: Joi.string().max(120).optional().label("Seller's Address Line 1"),
    fromAddr2: Joi.string().max(120).optional().label("Seller's Address Line 2"),
    fromPlace: Joi.string().max(50).optional().label("Seller's City"),
    actFromStateCode: Joi.number().integer().max(99).required(),
    fromPincode: Joi.number().integer().min(100000).max(999999).required().label("Seller's Pin Code"),
    fromStateCode: Joi.number().integer().max(99).required(),
    toGstin: Joi.string()
      .custom((value, helpers) => {
        if (value === 'URP') return value;
        if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(value)) {
          return helpers.error('string.pattern.base');
        }
        return value;
      })
      .required()
      .label("Customer's GSTIN"),
    toTrdName: Joi.string().max(100).optional().label("Customer's Trading Name"),
    toAddr1: Joi.string().max(120).optional().label("Customer's Address Line 1"),
    toAddr2: Joi.string().max(120).optional().label("Customer's Address Line 2"),
    toPlace: Joi.string().max(50).optional().label("Customer's City"),
    toPincode: Joi.number().integer().min(100000).max(999999).required().label("Customer's Pin Code"),
    actToStateCode: Joi.number().integer().max(99).required().label("Customer's Actual State"),
    toStateCode: Joi.number().integer().max(99).required().label("Customer's State"),
    transactionType: Joi.number().integer().min(1).max(4).required(),
    dispatchFromGSTIN: Joi.string()
      .length(15)
      .pattern(/^[0-9]{2}[0-9A-Z]{13}$/)
      .optional(),
    dispatchFromTradeName: Joi.string().max(100).optional().label("Seller's Trading Name"),
    shipToGSTIN: Joi.string()
      .length(15)
      .pattern(/^[0-9]{2}[0-9A-Z]{13}$/)
      .optional(),
    shipToTradeName: Joi.string().max(100).optional().label("Receiver's Trading Name"),
    totalValue: Joi.number().precision(2).optional(),
    cgstValue: Joi.number().precision(2).optional(),
    sgstValue: Joi.number().precision(2).optional(),
    igstValue: Joi.number().precision(2).optional(),
    cessValue: Joi.number().precision(2).optional(),
    cessNonAdvolValue: Joi.number().precision(2).optional(),
    otherValue: Joi.number().precision(2).optional(),
    totInvValue: Joi.number().precision(2).required(),
    transMode: Joi.string().valid('1', '2', '3', '4').optional(),
    transDistance: Joi.alternatives().try(Joi.string(), Joi.number().max(4000)).required(),
    transporterName: Joi.string().max(100).optional(),
    transporterId: Joi.string()
      .length(15)
      .pattern(/^[0-9]{2}[0-9A-Z]{13}$/)
      .optional(),
    transDocNo: Joi.string().max(15).optional(),
    transDocDate: Joi.string().optional(),
    vehicleNo: Joi.string().min(7).max(15).when('transMode', { is: '1', then: Joi.required(), otherwise: Joi.optional() }),
    vehicleType: Joi.string().when('transMode', { is: '1', then: Joi.required(), otherwise: Joi.optional() }),
    railwayReceiptNumber: Joi.string().when('transMode', { is: '2', then: Joi.required(), otherwise: Joi.optional() }),
    railwayReceiptDate: Joi.string().when('transMode', { is: '2', then: Joi.required(), otherwise: Joi.optional() }),
    airwayBillNumber: Joi.string().when('transMode', { is: '3', then: Joi.required(), otherwise: Joi.optional() }),
    airwayBillDate: Joi.string().when('transMode', { is: '3', then: Joi.required(), otherwise: Joi.optional() }),
    seawayBillNumber: Joi.string().when('transMode', { is: '4', then: Joi.required(), otherwise: Joi.optional() }),
    seawayBillDate: Joi.string().when('transMode', { is: '4', then: Joi.required(), otherwise: Joi.optional() }),
    itemList: Joi.array()
      .items(
        Joi.object({
          productName: Joi.string().max(100).optional(),
          productDesc: Joi.string().max(100).optional(),
          hsnCode: Joi.number().required(),
          quantity: Joi.number().required(),
          unitPrice: Joi.number(),
          qtyUnit: Joi.string().min(3).max(8).optional().label('Item Unit').messages({
            'string.min': 'Item unit "{{#value}}" must be 3 to 8 characters. Update the item unit and try again.',
            'string.max': 'Item unit "{{#value}}" must be 3 to 8 characters. Update the item unit and try again.',
            'string.empty': 'Please add {{#label}}',
          }),
          taxableAmount: Joi.number().precision(2).required(),
          sgstRate: Joi.number().precision(3).optional(),
          cgstRate: Joi.number().precision(3).optional(),
          igstRate: Joi.number().precision(3).optional(),
          cessRate: Joi.number().precision(3).optional(),
          cessNonAdvol: Joi.number().optional(),
        }),
      )
      .min(1)
      .required(),
  }).required(),
});

const generateEWayBillByIrnSchema = Joi.object({
  Irn: Joi.string().length(64).required().label('IRN').messages({
    'string.length': 'IRN must be 64 characters. Please regenerate the e-invoice.',
    'any.required': 'IRN not found for this invoice. Please generate the e-invoice first.',
  }),

  Distance: Joi.number().min(0).max(4000).required().label('Distance (KM)'),

  TransMode: Joi.string().valid('1', '2', '3', '4').optional().label('Transport Mode'),

  TransId: Joi.string()
    .pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}[Z]{1}[A-Z0-9]{1}$/)
    .optional()
    .label('Transporter ID')
    .messages({
      'string.pattern.base': 'Invalid Transporter ID. Please enter a valid 15-character GSTIN (e.g., 27AABCM8432E1ZL).',
    }),

  TransName: Joi.string().min(3).max(100).optional().label('Transporter Name'),

  TransDocNo: Joi.string().min(1).max(15).optional().label('Transport Document Number').messages({
    'string.max': 'Transport Document Number must not exceed 15 characters.',
  }),

  TransDocDt: Joi.string()
    .pattern(/^\d{2}\/\d{2}\/\d{4}$/)
    .required()
    .label('Transport Document Date (DD/MM/YYYY)'),

  VehNo: Joi.when('TransMode', {
    is: '1',
    then: Joi.string()
      .pattern(/^[A-Z]{2}\d{1,2}[A-Z]{1,2}\d{1,4}$/)
      .required()
      .min(4)
      .max(20)
      .label('Vehicle Number (Road)')
      .messages({
        'string.pattern.base': 'Invalid Vehicle Number. Use uppercase without spaces (e.g., GJ27N5909).',
      }),
    otherwise: Joi.string().min(4).max(20).optional(),
  }),

  VehType: Joi.when('TransMode', {
    is: '1',
    then: Joi.string().valid('R', 'O').required().label('Vehicle Type (Road)'),
    otherwise: Joi.string().valid('R', 'O').optional(),
  }),
})
  .or('TransMode', 'TransId')
  .messages({
    'object.missing': 'Either Transport Mode or Transporter ID is required to generate an e-way bill.',
  });

module.exports = { eInvoiceSchema, generateOnlyEWayBillSchema, generateEWayBillByIrnSchema };
