const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { getBooksModels } = require('../services/model.service');
const { COMPLAINT_MESSAGES } = require('../utils/messages');

const checkComplaintVisibility = async (req, res, next) => {
  try {
    const { Complaint, UserRole, Role } = getBooksModels();
    const companyId = req.query.companyId;
    const userId = req.user._id;
    const userRole = await UserRole.findOne({ userId, companyId }).select('roleId').lean();
    const role = userRole ? await Role.findOne({ _id: userRole.roleId, company: companyId }).select('role').lean() : null;

    req.complaintVisibility = /^admin$/i.test(role?.role || '')
      ? {}
      : { $or: [{ raisedBy: userId }, { againstPersonId: userId }] };

    const complaintIds = [req.params.complaintId, req.body?.linkedComplaintId].filter(Boolean);
    for (const complaintId of complaintIds) {
      const visible = await Complaint.exists({ _id: complaintId, companyId, ...req.complaintVisibility });
      if (!visible) {
        return next(new ApiError(httpStatus.NOT_FOUND, COMPLAINT_MESSAGES.FETCH_ONE_NOT_FOUND));
      }
    }
    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = { checkComplaintVisibility };
