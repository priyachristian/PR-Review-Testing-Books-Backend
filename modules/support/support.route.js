const express = require('express');
const supportValidation = require('./support.validation');
const supportController = require('./support.controller');
const validate = require('../../middlewares/validate');
const { checkRoleRight } = require('../../middlewares/checkRoleRight');
const { multipleAttachmentUpload, multerErrorHandler } = require('../../middlewares/uploadMiddleware');
const parseFormData = require('../../middlewares/parseFormData');
const { RIGHT_LIST, RIGHTS, ATTACHMENT_MAX_COUNT } = require('../../utils/enum');

const router = express.Router();

const uploadFields = multipleAttachmentUpload('attachment', ATTACHMENT_MAX_COUNT);

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.SUPPORT, RIGHTS.CREATE),
    uploadFields,
    multerErrorHandler,
    parseFormData,
    validate(supportValidation.createSupport),
    supportController.createSupport,
  )
  .get(checkRoleRight(RIGHT_LIST.SUPPORT, RIGHTS.VIEW), validate(supportValidation.getSupports), supportController.getSupports);

router
  .route('/:supportId')
  .get(checkRoleRight(RIGHT_LIST.SUPPORT, RIGHTS.VIEW), validate(supportValidation.getSupport), supportController.getSupport)
  .patch(
    checkRoleRight(RIGHT_LIST.SUPPORT, RIGHTS.EDIT),
    validate(supportValidation.updateSupport),
    supportController.updateSupport,
  );

router
  .route('/:supportId/comment')
  .post(checkRoleRight(RIGHT_LIST.SUPPORT, RIGHTS.EDIT), validate(supportValidation.addComment), supportController.addComment);

router
  .route('/:supportId/updateStatus')
  .patch(
    checkRoleRight(RIGHT_LIST.SUPPORT, RIGHTS.EDIT),
    validate(supportValidation.updateStatus),
    supportController.updateStatus,
  );

module.exports = router;
