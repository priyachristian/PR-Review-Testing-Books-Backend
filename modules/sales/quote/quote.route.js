const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const quoteValidation = require('./quote.validation');
const quoteController = require('./quote.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { checkPrimaryBank } = require('../../../middlewares/checkPrimaryBank');
const validateDocumentTotals = require('../../../middlewares/checkDocTotal');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT } = require('../../../utils/enum');

const router = express.Router();

const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.QUOTATION),
    checkRoleRight(RIGHT_LIST.QUOTES, RIGHTS.CREATE),
    checkPrimaryBank,
    validate(quoteValidation.createQuote),
    validateDocumentTotals,
    quoteController.createQuote,
  )
  .get(checkRoleRight(RIGHT_LIST.QUOTES, RIGHTS.VIEW), validate(quoteValidation.getQuotes), quoteController.getQuotes);

router
  .route('/exports')
  .get(
    checkRoleRight(RIGHT_LIST.QUOTES, RIGHTS.VIEW),
    validate(quoteValidation.getQuotesExports),
    quoteController.getQuotesExports,
  );

router
  .route('/:quoteId')
  .get(checkRoleRight(RIGHT_LIST.QUOTES, RIGHTS.VIEW), validate(quoteValidation.getQuote), quoteController.getQuote)
  .delete(checkRoleRight(RIGHT_LIST.QUOTES, RIGHTS.DELETE), validate(quoteValidation.deleteQuote), quoteController.deleteQuote)
  .patch(
    checkRoleRight(RIGHT_LIST.QUOTES, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(quoteValidation.updateQuote),
    validateDocumentTotals,
    quoteController.updateQuote,
  );

router
  .route('/:quoteId/send')
  .post(checkRoleRight(RIGHT_LIST.QUOTES, RIGHTS.EDIT), validate(quoteValidation.sendQuote), quoteController.sendQuote);

router
  .route('/:quoteId/status')
  .patch(
    checkRoleRight(RIGHT_LIST.QUOTES, RIGHTS.EDIT),
    validate(quoteValidation.updateQuoteStatus),
    quoteController.updateQuoteStatus,
  );

module.exports = router;
