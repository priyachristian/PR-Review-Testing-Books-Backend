const express = require('express');
const priceListValidation = require('./priceList.validation');
const priceListController = require('./priceList.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(
    checkRoleRight(RIGHT_LIST.PRICE_LIST, RIGHTS.CREATE),
    validate(priceListValidation.createPriceList),
    priceListController.createPriceList,
  )
  .get(
    checkRoleRight(RIGHT_LIST.PRICE_LIST, RIGHTS.VIEW),
    validate(priceListValidation.getPriceLists),
    priceListController.getPriceLists,
  );

router.route('/dropdown').get(validate(priceListValidation.getPriceListsDropdown), priceListController.dropdownPriceLists);

router
  .route('/:priceListId')
  .get(
    checkRoleRight(RIGHT_LIST.PRICE_LIST, RIGHTS.VIEW),
    validate(priceListValidation.getPriceList),
    priceListController.getPriceList,
  )
  .delete(
    checkRoleRight(RIGHT_LIST.PRICE_LIST, RIGHTS.DELETE),
    validate(priceListValidation.deletePriceList),
    priceListController.deletePriceList,
  )
  .patch(
    checkRoleRight(RIGHT_LIST.PRICE_LIST, RIGHTS.EDIT),
    validate(priceListValidation.updatePriceList),
    priceListController.updatePriceList,
  );

module.exports = router;
