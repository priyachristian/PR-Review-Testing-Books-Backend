const express = require('express');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const manualJournalValidation = require('./manualJournal.validation');
const manualJournalController = require('./manualJournal.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const parseFormData = require('../../../middlewares/parseFormData');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../../middlewares/uploadMiddleware');
const { checkSubscription } = require('../../../middlewares/checkSubscription');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT } = require('../../../utils/enum');

const router = express.Router();

const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    uploadFields,
    multerErrorHandler,
    parseFormData,
    checkSubscription(PLAN_FEATURES.MANUAL_JOURNAL),
    checkRoleRight(RIGHT_LIST.MANUAL_JOURNAL, RIGHTS.CREATE),
    validate(manualJournalValidation.createManualJournal),
    manualJournalController.createManualJournal,
  )
  .get(
    checkRoleRight(RIGHT_LIST.MANUAL_JOURNAL, RIGHTS.VIEW),
    validate(manualJournalValidation.getManualJournals),
    manualJournalController.getManualJournals,
  );

router.route('/dropdown').get(validate(manualJournalValidation.getContactDropdown), manualJournalController.getContactDropdown);

router
  .route('/:manualJournalId')
  .get(
    checkRoleRight(RIGHT_LIST.MANUAL_JOURNAL, RIGHTS.VIEW),
    validate(manualJournalValidation.getManualJournal),
    manualJournalController.getManualJournal,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.MANUAL_JOURNAL, RIGHTS.EDIT),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(manualJournalValidation.updateManualJournal),
    manualJournalController.updateManualJournal,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.MANUAL_JOURNAL, RIGHTS.DELETE),
    validate(manualJournalValidation.deleteManualJournal),
    manualJournalController.deleteManualJournal,
  );

module.exports = router;
