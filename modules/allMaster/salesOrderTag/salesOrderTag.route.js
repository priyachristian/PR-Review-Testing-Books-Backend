const express = require('express');
const salesOrderTagValidation = require('./salesOrderTag.validation');
const salesOrderTagController = require('./salesOrderTag.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.SALES_ORDER_TAG, RIGHTS.CREATE),
    validate(salesOrderTagValidation.createTag),
    salesOrderTagController.createTag,
  )
  .get(
    checkRoleRight(RIGHT_LIST.SALES_ORDER_TAG, RIGHTS.VIEW),
    validate(salesOrderTagValidation.getTags),
    salesOrderTagController.getTags,
  );

router.get('/dropdown', validate(salesOrderTagValidation.getTagDropdown), salesOrderTagController.getTagDropdown);

router
  .route('/:tagId')
  .put(
    checkRoleRight(RIGHT_LIST.SALES_ORDER_TAG, RIGHTS.EDIT),
    validate(salesOrderTagValidation.updateTag),
    salesOrderTagController.updateTag,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.SALES_ORDER_TAG, RIGHTS.DELETE),
    validate(salesOrderTagValidation.deleteTag),
    salesOrderTagController.deleteTag,
  )
  .get(
    checkRoleRight(RIGHT_LIST.SALES_ORDER_TAG, RIGHTS.VIEW),
    validate(salesOrderTagValidation.getTagById),
    salesOrderTagController.getTagById,
  );

module.exports = router;
