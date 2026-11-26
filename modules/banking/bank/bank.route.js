const express = require('express');
const {
  createBank,
  getBanks,
  updateBank,
  deleteBank,
  bankDropdown,
  transfer,
  getBankById,
  transaction,
  getTransactions,
  getTransactionById,
  approveTransaction,
  rejectTransaction,
  cancelTransaction,
} = require('./bank.validation');
const bankController = require('./bank.controller');
const validate = require('../../../middlewares/validate');
const { checkRoleRight } = require('../../../middlewares/checkRoleRight');
const { RIGHT_LIST, RIGHTS } = require('../../../utils/enum');

const router = express.Router();

router
  .route('/')
  .post(checkRoleRight(RIGHT_LIST.BANK, RIGHTS.CREATE), validate(createBank), bankController.createBank)
  .get(checkRoleRight(RIGHT_LIST.BANK, RIGHTS.VIEW), validate(getBanks), bankController.getBanksByCompanyId);

router.post('/transfer', checkRoleRight(RIGHT_LIST.BANK, RIGHTS.EDIT), validate(transfer), bankController.transferAmount);

router
  .route('/transaction')
  .post(checkRoleRight(RIGHT_LIST.BANK_TRANSFER_LOG, RIGHTS.EDIT), validate(transaction), bankController.transaction)
  .get(checkRoleRight(RIGHT_LIST.BANK_TRANSFER_LOG, RIGHTS.VIEW), validate(getTransactions), bankController.getTransactions);

router.get(
  '/transaction/:transactionId',
  checkRoleRight(RIGHT_LIST.BANK_TRANSFER_LOG, RIGHTS.VIEW),
  validate(getTransactionById),
  bankController.getTransactionById,
);

router.post(
  '/transaction/approve',
  checkRoleRight(RIGHT_LIST.BANK_TRANSFER_LOG, RIGHTS.EDIT),
  validate(approveTransaction),
  bankController.approveTransaction,
);
router.post(
  '/transaction/reject',
  checkRoleRight(RIGHT_LIST.BANK_TRANSFER_LOG, RIGHTS.EDIT),
  validate(rejectTransaction),
  bankController.rejectTransaction,
);
router.post(
  '/transaction/cancel',
  checkRoleRight(RIGHT_LIST.BANK_TRANSFER_LOG, RIGHTS.EDIT),
  validate(cancelTransaction),
  bankController.cancelTransaction,
);

router.get('/dropdown', validate(bankDropdown), bankController.bankDropdown);

router
  .route('/:bankId')
  .get(checkRoleRight(RIGHT_LIST.BANK, RIGHTS.VIEW), validate(getBankById), bankController.getBankById)
  .delete(checkRoleRight(RIGHT_LIST.BANK, RIGHTS.DELETE), validate(deleteBank), bankController.deleteBank)
  .put(checkRoleRight(RIGHT_LIST.BANK, RIGHTS.EDIT), validate(updateBank), bankController.updateBank);

module.exports = router;
