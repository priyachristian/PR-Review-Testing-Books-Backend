const express = require('express');
const subItemGroupValidation = require('./subItemGroup.validation');
const subItemGroupController = require('./subItemGroup.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.ITEM_GROUP, RIGHTS.CREATE),
    validate(subItemGroupValidation.createSubItemGroup),
    subItemGroupController.createSubItemGroup,
  )
  .get(
    checkRoleRight(RIGHT_LIST.ITEM_GROUP, RIGHTS.VIEW),
    validate(subItemGroupValidation.getSubItemGroups),
    subItemGroupController.getSubItemGroups,
  );

router
  .route('/dropdown')
  .get(validate(subItemGroupValidation.getSubItemGroupsDropdown), subItemGroupController.subItemGroupDropdown);

router
  .route('/:subItemGroupId')
  .get(
    checkRoleRight(RIGHT_LIST.ITEM_GROUP, RIGHTS.VIEW),
    validate(subItemGroupValidation.getSubItemGroup),
    subItemGroupController.getSubItemGroup,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.ITEM_GROUP, RIGHTS.EDIT),
    validate(subItemGroupValidation.updateSubItemGroup),
    subItemGroupController.updateSubItemGroup,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.ITEM_GROUP, RIGHTS.DELETE),
    validate(subItemGroupValidation.deleteSubItemGroup),
    subItemGroupController.deleteSubItemGroup,
  );

module.exports = router;
