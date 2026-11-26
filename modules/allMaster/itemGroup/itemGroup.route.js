const express = require('express');
const itemGroupValidation = require('./itemGroup.validation');
const itemGroupController = require('./itemGroup.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.ITEM_GROUP, RIGHTS.CREATE),
    validate(itemGroupValidation.createItemGroup),
    itemGroupController.createItemGroup,
  )
  .get(
    checkRoleRight(RIGHT_LIST.ITEM_GROUP, RIGHTS.VIEW),
    validate(itemGroupValidation.getItemGroups),
    itemGroupController.getItemGroups,
  );

router.route('/dropdown').get(validate(itemGroupValidation.getItemGroupsDropdown), itemGroupController.itemGroupDropdown);

router
  .route('/:itemGroupId')
  .get(
    checkRoleRight(RIGHT_LIST.ITEM_GROUP, RIGHTS.VIEW),
    validate(itemGroupValidation.getItemGroup),
    itemGroupController.getItemGroup,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.ITEM_GROUP, RIGHTS.EDIT),
    validate(itemGroupValidation.updateItemGroup),
    itemGroupController.updateItemGroup,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.ITEM_GROUP, RIGHTS.DELETE),
    validate(itemGroupValidation.deleteItemGroup),
    itemGroupController.deleteItemGroup,
  );

module.exports = router;
