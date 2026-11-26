const httpStatus = require('http-status');
const { getBooksModels, getBooksCrmModels, getCommonModels } = require('../../services/model.service');
const ApiError = require('../../utils/ApiError');
const { COMPLAINT_MESSAGES } = require('../../utils/messages');
const { handleFileUpdate } = require('../commonModule/fileUpload/fileUploadS3.service');
const {
  ATTACHMENT_TYPES,
  COMPLAINT_FORM_TYPES,
  COMPLAINT_STEPS,
  COMPLAINT_STEP_ORDER,
  COMPLAINT_PRODUCT_RELATED_PATH_NAMES,
  COMPLAINT_LIST_STATUS,
  PROBLEM_TYPES,
} = require('@smit9313/abss-models-core/src/utils/enum');

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const LIST_SELECT_FIELDS =
  'complaintNo createdAt problemPath customerId assignedTo dueDate currentStep isWaiting waitingStartedAt isNotRealComplaint isClosed';

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isFilled = value => value != null && String(value).trim() !== '';

const uniqueObjectIds = values => [...new Set((values || []).filter(Boolean).map(String))];

const formatPersonName = user => {
  if (!user) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || null;
};

const getPlainSubdoc = value => value?.toObject?.() || value || {};

const calcDueDateFromDays = sortOutWithinDays => {
  if (sortOutWithinDays == null) return null;
  return new Date(Date.now() + Number(sortOutWithinDays) * MS_PER_DAY);
};

const nextStepOf = step => {
  const index = COMPLAINT_STEP_ORDER.indexOf(step);
  if (index < 0 || index >= COMPLAINT_STEP_ORDER.length - 1) return null;
  return COMPLAINT_STEP_ORDER[index + 1];
};

const pushHistory = (complaint, { step, action, description, userId, attachments = [], photos = [] }) => {
  complaint.history.push({
    step: step || null,
    action,
    description: description || '',
    addedBy: userId || null,
    attachments,
    photos,
    createdAt: new Date(),
  });
};

const pushUpdatedBy = (complaint, userId) => {
  complaint.updatedBy = userId;
};

const getOrCreateStepRecord = (complaint, step) => {
  let record = complaint.steps.find(item => item.step === step);
  if (!record) {
    complaint.steps.push({
      step,
      startedAt: new Date(),
      completedAt: null,
      completedBy: null,
      isSkipped: false,
    });
    record = complaint.steps[complaint.steps.length - 1];
  }
  if (!record.startedAt) {
    record.startedAt = new Date();
  }
  return record;
};

const markStepCompleted = (record, userId) => {
  record.completedAt = new Date();
  record.completedBy = userId;
};

const advanceToStep = (complaint, nextStep, userId) => {
  endWaitingIfActive(complaint);
  const currentRecord = getOrCreateStepRecord(complaint, complaint.currentStep);
  markStepCompleted(currentRecord, userId);
  complaint.currentStep = nextStep;
  getOrCreateStepRecord(complaint, nextStep);
  return currentRecord;
};

const saveComplaint = async (complaint, userId) => {
  pushUpdatedBy(complaint, userId);
  await complaint.save();
  return populateComplaintRelations(complaint);
};

const mergeStepData = (record, field, patch) => {
  record[field] = {
    ...getPlainSubdoc(record[field]),
    ...patch,
  };
  return record[field];
};

const findComplaintOrThrow = async (complaintId, companyId) => {
  const { Complaint } = getBooksModels();
  const complaint = await Complaint.findOne({ _id: complaintId, companyId });
  if (!complaint) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPLAINT_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return complaint;
};

const assertCurrentStep = (complaint, expectedStep) => {
  if (complaint.currentStep !== expectedStep) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.INVALID_STEP);
  }
};

const loadComplaintForWork = async (complaintId, companyId, expectedStep = null) => {
  const complaint = await findComplaintOrThrow(complaintId, companyId);
  if (complaint.isNotRealComplaint) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.ALREADY_NOT_REAL);
  }
  if (complaint.isClosed) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.ALREADY_CLOSED);
  }
  if (expectedStep) assertCurrentStep(complaint, expectedStep);
  endWaitingIfActive(complaint);
  return complaint;
};

const assertActionable = complaint => {
  if (complaint.isNotRealComplaint) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.ALREADY_NOT_REAL);
  }
  if (complaint.isClosed) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.ALREADY_CLOSED);
  }
};

const assertNotAlreadyNotReal = complaint => {
  if (complaint.isNotRealComplaint) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPLAINT_MESSAGES.ALREADY_NOT_REAL);
  }
};

const buildProblemPathAndAttachments = async (ProblemList, problem, companyId) => {
  const pathNames = [];
  let current = problem;

  while (current) {
    pathNames.unshift(current.name);
    if (!current.parentProblemId) break;
    // eslint-disable-next-line no-await-in-loop
    current = await ProblemList.findOne({ _id: current.parentProblemId, companyId }).lean();
  }

  return {
    problemPath: pathNames,
    requiredAttachments: [...(problem.requiredAttachments || [])],
  };
};

const resolveFormTypeFromPath = (problemPath, problemType) => {
  if (problemType === 'CUSTOMER_ISSUE' || problemPath.includes('Customer Issue')) {
    return COMPLAINT_FORM_TYPES.CUSTOMER_ISSUE;
  }
  if (problemPath.includes('Person → Person') || problemPath.includes('Person -> Person')) {
    return COMPLAINT_FORM_TYPES.PERSON_TO_PERSON;
  }
  if (problemPath.includes('Department → Department') || problemPath.includes('Department -> Department')) {
    return COMPLAINT_FORM_TYPES.DEPARTMENT_TO_DEPARTMENT;
  }
  return null;
};

const isProductRelatedPath = problemPath =>
  COMPLAINT_PRODUCT_RELATED_PATH_NAMES.some(name => problemPath.some(part => part === name || part.includes(name)));

const evidenceHasValueForType = (type, item) => {
  switch (type) {
    case ATTACHMENT_TYPES.DATE:
      return isFilled(item.date);
    case ATTACHMENT_TYPES.INVOICE:
      return isFilled(item.invoiceId);
    case ATTACHMENT_TYPES.BILL:
      return isFilled(item.billId);
    case ATTACHMENT_TYPES.ITEM_QUANTITY:
      return isFilled(item.itemId) && item.quantity != null;
    case ATTACHMENT_TYPES.BATCH:
      return isFilled(item.batchNumber);
    case ATTACHMENT_TYPES.AMOUNT:
      return item.amount != null;
    case ATTACHMENT_TYPES.SALES_PERSON:
      return isFilled(item.salesPersonId);
    case ATTACHMENT_TYPES.PHOTO:
      return isFilled(item.fileUrl) || isFilled(item.fileName);
    case ATTACHMENT_TYPES.TRANSPORT:
      return isFilled(item.fileUrl) || isFilled(item.value);
    default:
      return false;
  }
};

const validateEvidence = (requiredAttachments, evidence = []) => {
  if (!requiredAttachments.length) return;

  const byType = new Map((evidence || []).map(item => [item.type, item]));
  for (const type of requiredAttachments) {
    const item = byType.get(type);
    if (!item || !evidenceHasValueForType(type, item)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${COMPLAINT_MESSAGES.EVIDENCE_REQUIRED}: ${type}`);
    }
  }
};

const enrichPhotoEvidence = (evidence = [], photoUrls = []) => {
  if (!Array.isArray(evidence) || !evidence.length) return evidence || [];
  const urls = Array.isArray(photoUrls) ? photoUrls.filter(Boolean) : [];
  let nextUrlIndex = 0;

  return evidence.map(item => {
    if (item?.type !== ATTACHMENT_TYPES.PHOTO) return item;
    if (isFilled(item.fileUrl)) return item;
    const url = urls[nextUrlIndex++];
    if (!url) return item;
    return {
      ...item,
      fileUrl: url,
      fileName: item.fileName || url.split('/').pop() || null,
    };
  });
};

const validateCreateParties = body => {
  const { formType } = body;

  if (formType === COMPLAINT_FORM_TYPES.DEPARTMENT_TO_DEPARTMENT) {
    if (!body.fromDepartment || !body.againstDepartment || !body.raisedBy) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'fromDepartment, againstDepartment and raisedBy are required');
    }
  }

  if (formType === COMPLAINT_FORM_TYPES.PERSON_TO_PERSON) {
    if (!body.raisedBy || !body.againstPersonId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'raisedBy and againstPersonId are required');
    }
  }

  if (formType === COMPLAINT_FORM_TYPES.CUSTOMER_ISSUE) {
    if (!body.customerId || !body.contactChannel || !body.raisedBy) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'customerId, contactChannel and raisedBy are required');
    }
  }
};

const endWaitingIfActive = complaint => {
  if (!complaint.isWaiting) return;

  if (complaint.waitingStartedAt) {
    const pausedMs = Math.max(Date.now() - new Date(complaint.waitingStartedAt).getTime(), 0);
    complaint.pausedMsTotal = (complaint.pausedMsTotal || 0) + pausedMs;
    if (complaint.dueDate) {
      complaint.dueDate = new Date(new Date(complaint.dueDate).getTime() + pausedMs);
    }
  }

  complaint.isWaiting = false;
  complaint.waitingEndedAt = new Date();
  complaint.waitingReason = null;
  complaint.waitingWhy = null;
};

const syncMediaField = async ({ newFiles = [], currentUrls, existingUrls = [], userId, companyId, skipS3Deletion = false }) =>
  handleFileUpdate({
    newFiles,
    currentUrls: currentUrls || existingUrls,
    existingUrls,
    userId,
    companyId,
    skipS3Deletion,
  });

const appendOptionalMedia = async (complaint, { attachmentFiles = [], photoFiles = [], body = {}, userId, companyId }) => {
  const previousAttachments = [...(complaint.attachments || [])];
  const previousPhotos = [...(complaint.photos || [])];

  const attachmentUrls = await syncMediaField({
    newFiles: attachmentFiles,
    currentUrls: body.attachments || previousAttachments,
    existingUrls: previousAttachments,
    userId,
    companyId,
  });
  const photoUrls = await syncMediaField({
    newFiles: photoFiles,
    currentUrls: body.photos || previousPhotos,
    existingUrls: previousPhotos,
    userId,
    companyId,
  });

  complaint.attachments = attachmentUrls;
  complaint.photos = photoUrls;

  return {
    actionAttachments: attachmentUrls.filter(url => !previousAttachments.includes(url)),
    actionPhotos: photoUrls.filter(url => !previousPhotos.includes(url)),
  };
};

const uploadCreateMedia = async ({ attachmentFiles = [], photoFiles = [], body = {}, userId, companyId }) => {
  const existingAttachments = body.attachments || [];
  const existingPhotos = body.photos || [];

  const attachments = await syncMediaField({
    newFiles: attachmentFiles,
    currentUrls: existingAttachments,
    existingUrls: [],
    userId,
    companyId,
  });
  const photos = await syncMediaField({
    newFiles: photoFiles,
    currentUrls: existingPhotos,
    existingUrls: [],
    userId,
    companyId,
  });

  return {
    attachments,
    photos,
    newlyUploadedUrls: [
      ...attachments.filter(url => !existingAttachments.includes(url)),
      ...photos.filter(url => !existingPhotos.includes(url)),
    ],
  };
};

const resolveListStatus = status => {
  if (!status) return null;
  const value = String(status).trim().toUpperCase();
  if (value === 'PROCESSING' || value === 'GOING_ON') return COMPLAINT_LIST_STATUS.GOING_ON;
  if (value === 'FINISH' || value === 'FINISHED') return COMPLAINT_LIST_STATUS.FINISHED;
  if (value === 'NEED_ACTION' || value === 'NEEDS_ACTION') return COMPLAINT_LIST_STATUS.NEEDS_ACTION;
  if (value === 'ONHOLD' || value === 'ON_HOLD') return COMPLAINT_LIST_STATUS.ON_HOLD;
  return status;
};

const buildListStatusQuery = status => {
  const resolved = resolveListStatus(status);
  if (!resolved) return {};

  switch (resolved) {
    case COMPLAINT_LIST_STATUS.NEEDS_ACTION:
      return {
        currentStep: { $in: [COMPLAINT_STEPS.NEW, COMPLAINT_STEPS.ASSIGNED] },
        isWaiting: { $ne: true },
        isNotRealComplaint: { $ne: true },
        isClosed: { $ne: true },
      };
    case COMPLAINT_LIST_STATUS.GOING_ON:
      return {
        currentStep: {
          $in: [COMPLAINT_STEPS.IN_PROGRESS, COMPLAINT_STEPS.ACTION_TAKEN, COMPLAINT_STEPS.VERIFIED, COMPLAINT_STEPS.CLOSED],
        },
        isWaiting: { $ne: true },
        isNotRealComplaint: { $ne: true },
        isClosed: { $ne: true },
      };
    case COMPLAINT_LIST_STATUS.ON_HOLD:
      return {
        isWaiting: true,
        isClosed: { $ne: true },
        isNotRealComplaint: { $ne: true },
      };
    case COMPLAINT_LIST_STATUS.FINISHED:
      return {
        $or: [{ isClosed: true }, { isNotRealComplaint: true }],
      };
    default:
      return {};
  }
};

const mergeListQuery = (baseQuery = {}, statusQuery = {}) => {
  const base = { ...baseQuery };
  const status = { ...statusQuery };
  const andConditions = [];

  if (base.$or) {
    andConditions.push({ $or: base.$or });
    delete base.$or;
  }
  if (status.$or) {
    andConditions.push({ $or: status.$or });
    delete status.$or;
  }

  const query = { ...base, ...status };
  if (andConditions.length) {
    query.$and = [...(query.$and || []), ...andConditions];
  }
  return query;
};

const buildListBaseQuery = async filter => {
  const { companyId, search, assignedTo, customerId, problemType } = filter;
  const query = { companyId };

  if (assignedTo) query.assignedTo = assignedTo;
  if (customerId) query.customerId = customerId;
  if (problemType) query.problemType = problemType;

  if (!search?.trim()) return query;

  const regex = new RegExp(escapeRegex(search.trim()), 'i');
  const { Customer } = getBooksCrmModels();
  const matchingCustomers = await Customer.find({
    companyId,
    $or: [{ customerDisplayName: regex }, { companyName: regex }],
  })
    .select('_id')
    .lean();

  const matchedCustomerIds = matchingCustomers.map(customer => customer._id);
  query.$or = [
    { complaintNo: regex },
    { problemPath: regex },
    ...(matchedCustomerIds.length ? [{ customerId: { $in: matchedCustomerIds } }] : []),
  ];

  return query;
};

const getListStatusForComplaint = complaint => {
  if (complaint.isNotRealComplaint || complaint.isClosed) {
    return COMPLAINT_LIST_STATUS.FINISHED;
  }
  if (complaint.isWaiting) return COMPLAINT_LIST_STATUS.ON_HOLD;
  if ([COMPLAINT_STEPS.NEW, COMPLAINT_STEPS.ASSIGNED].includes(complaint.currentStep)) {
    return COMPLAINT_LIST_STATUS.NEEDS_ACTION;
  }
  if (
    [COMPLAINT_STEPS.IN_PROGRESS, COMPLAINT_STEPS.ACTION_TAKEN, COMPLAINT_STEPS.VERIFIED, COMPLAINT_STEPS.CLOSED].includes(
      complaint.currentStep,
    )
  ) {
    return COMPLAINT_LIST_STATUS.GOING_ON;
  }
  return complaint.currentStep;
};

const formatDurationLabel = remainingMs => {
  const abs = Math.abs(remainingMs);
  const days = Math.floor(abs / MS_PER_DAY);
  const hours = Math.floor((abs % MS_PER_DAY) / MS_PER_HOUR);
  const parts = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours > 0 || days === 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  return parts.join(' ');
};

const formatComplaintTimeLeft = complaint => {
  if (!complaint.dueDate) return null;

  const dueMs = new Date(complaint.dueDate).getTime();
  const referenceMs =
    complaint.isWaiting && complaint.waitingStartedAt ? new Date(complaint.waitingStartedAt).getTime() : Date.now();
  const remainingMs = dueMs - referenceMs;
  const label = formatDurationLabel(remainingMs);

  return remainingMs < 0 ? `Overdue by ${label}` : `${label} left`;
};

const loadListLookups = async complaints => {
  const { Customer } = getBooksCrmModels();
  const { User } = getCommonModels();

  const customerIds = uniqueObjectIds(complaints.map(item => item.customerId));
  const userIds = uniqueObjectIds(complaints.map(item => item.assignedTo));

  const [customers, users] = await Promise.all([
    customerIds.length
      ? Customer.find({ _id: { $in: customerIds } })
          .select('customerDisplayName companyName')
          .lean()
      : [],
    userIds.length
      ? User.find({ _id: { $in: userIds } })
          .select('firstName lastName')
          .lean()
      : [],
  ]);

  return {
    customerNameById: new Map(
      customers.map(customer => [String(customer._id), customer.customerDisplayName || customer.companyName || null]),
    ),
    userNameById: new Map(users.map(user => [String(user._id), formatPersonName(user)])),
  };
};

const mapComplaintToListRow = (complaint, { customerNameById, userNameById }) => {
  const doc = complaint.toObject ? complaint.toObject() : complaint;
  return {
    id: doc._id,
    complaintNo: doc.complaintNo,
    date: doc.createdAt || null,
    problemPath: doc.problemPath || [],
    customerName: doc.customerId ? customerNameById.get(String(doc.customerId)) || null : null,
    userName: doc.assignedTo ? userNameById.get(String(doc.assignedTo)) || null : null,
    time: formatComplaintTimeLeft(doc),
    status: getListStatusForComplaint(doc),
    step: doc.currentStep || null,
    isNotRealComplaint: Boolean(doc.isNotRealComplaint),
  };
};

const populateComplaintRelations = async complaint => {
  const doc = complaint.toObject ? complaint.toObject() : { ...complaint };

  const { User } = getCommonModels();
  const { Customer, Item } = getBooksCrmModels();
  const { Invoice, Bill } = getBooksModels();

  const evidence = doc.evidence || [];
  const history = doc.history || [];
  const teamNotes = doc.teamNotes || [];
  const teamTasks = doc.teamTasks || [];

  const invoiceIds = uniqueObjectIds(evidence.map(item => item.invoiceId));
  const billIds = uniqueObjectIds(evidence.map(item => item.billId));
  const itemIds = uniqueObjectIds(evidence.map(item => item.itemId));

  const userIds = uniqueObjectIds([
    doc.assignedTo,
    ...history.map(entry => entry.addedBy),
    ...teamNotes.map(note => note.addedBy),
    ...teamTasks.flatMap(task => [task.addedBy, task.assignedTo]),
    ...(doc.steps || []).map(step => step.completedBy),
  ]);

  const [users, customer, invoices, bills, items] = await Promise.all([
    userIds.length
      ? User.find({ _id: { $in: userIds } })
          .select('firstName lastName')
          .lean()
      : [],
    doc.customerId
      ? Customer.findById(doc.customerId).select('customerDisplayName companyName customerPhoneNumber').lean()
      : null,
    invoiceIds.length
      ? Invoice.find({ _id: { $in: invoiceIds } })
          .select('invoiceId')
          .lean()
      : [],
    billIds.length
      ? Bill.find({ _id: { $in: billIds } })
          .select('billId')
          .lean()
      : [],
    itemIds.length
      ? Item.find({ _id: { $in: itemIds } })
          .select('itemName itemNo')
          .lean()
      : [],
  ]);

  const userById = new Map(users.map(user => [String(user._id), user]));

  const getUser = userId => {
    if (!userId) return null;
    const user = userById.get(String(userId));
    if (!user) {
      return {
        _id: userId,
        name: null,
      };
    }
    return {
      _id: user._id,
      name: formatPersonName(user),
    };
  };

  doc.assignedTo = doc.assignedTo ? getUser(doc.assignedTo) : null;

  doc.customerId = customer
    ? {
        _id: customer._id,
        customerName: customer.customerDisplayName || customer.companyName || null,
        phoneNumber: customer.customerPhoneNumber || null,
      }
    : doc.customerId || null;

  const invoiceById = new Map(invoices.map(invoice => [String(invoice._id), invoice]));
  const billById = new Map(bills.map(bill => [String(bill._id), bill]));
  const itemById = new Map(items.map(item => [String(item._id), item]));

  doc.evidence = evidence.map(item => {
    const next = { ...item };
    if (item.invoiceId) {
      const invoice = invoiceById.get(String(item.invoiceId));
      next.invoiceId = invoice
        ? {
            _id: invoice._id,
            invoiceId: invoice.invoiceId,
          }
        : {
            _id: item.invoiceId,
            invoiceId: null,
          };
    }
    if (item.billId) {
      const bill = billById.get(String(item.billId));
      next.billId = bill
        ? {
            _id: bill._id,
            billId: bill.billId,
          }
        : {
            _id: item.billId,
            billId: null,
          };
    }
    if (item.itemId) {
      const master = itemById.get(String(item.itemId));
      next.itemId = master
        ? {
            _id: master._id,
            itemName: master.itemName || null,
            itemNo: master.itemNo || null,
          }
        : {
            _id: item.itemId,
            itemName: null,
            itemNo: null,
          };
    }
    return next;
  });
  doc.history = history.map(entry => ({
    ...entry,
    addedBy: entry.addedBy ? getUser(entry.addedBy) : null,
  }));
  doc.teamNotes = teamNotes.map(note => ({
    ...note,
    addedBy: note.addedBy ? getUser(note.addedBy) : null,
  }));
  doc.teamTasks = teamTasks.map(task => ({
    ...task,
    addedBy: task.addedBy ? getUser(task.addedBy) : null,
    assignedTo: task.assignedTo ? getUser(task.assignedTo) : null,
  }));
  doc.steps = (doc.steps || []).map(step => ({
    ...step,
    completedBy: step.completedBy ? getUser(step.completedBy) : null,
  }));

  return doc;
};

const getListStatusCounts = async (Complaint, baseQuery) => {
  const [needsAction, goingOn, onHold, finished] = await Promise.all([
    Complaint.countDocuments(mergeListQuery(baseQuery, buildListStatusQuery(COMPLAINT_LIST_STATUS.NEEDS_ACTION))),
    Complaint.countDocuments(mergeListQuery(baseQuery, buildListStatusQuery(COMPLAINT_LIST_STATUS.GOING_ON))),
    Complaint.countDocuments(mergeListQuery(baseQuery, buildListStatusQuery(COMPLAINT_LIST_STATUS.ON_HOLD))),
    Complaint.countDocuments(mergeListQuery(baseQuery, buildListStatusQuery(COMPLAINT_LIST_STATUS.FINISHED))),
  ]);

  return { needsAction, goingOn, onHold, finished };
};

const getOppositeProblemTypeCounts = async (Complaint, filter, visibilityQuery = {}) => {
  const { problemType } = filter;
  if (!problemType) return {};

  let oppositeType = null;
  let countKey = null;
  if (problemType === PROBLEM_TYPES.CUSTOMER_ISSUE) {
    oppositeType = PROBLEM_TYPES.INTERNAL_EMPLOYEE_ISSUE;
    countKey = 'internalCount';
  } else if (problemType === PROBLEM_TYPES.INTERNAL_EMPLOYEE_ISSUE) {
    oppositeType = PROBLEM_TYPES.CUSTOMER_ISSUE;
    countKey = 'customerCount';
  }
  if (!oppositeType) return {};

  const oppositeQuery = mergeListQuery(await buildListBaseQuery({ ...filter, problemType: oppositeType }), visibilityQuery);
  const count = await Complaint.countDocuments(oppositeQuery);
  return { [countKey]: count };
};

module.exports = {
  LIST_SELECT_FIELDS,
  nextStepOf,
  pushHistory,
  pushUpdatedBy,
  getOrCreateStepRecord,
  markStepCompleted,
  advanceToStep,
  saveComplaint,
  mergeStepData,
  getPlainSubdoc,
  findComplaintOrThrow,
  loadComplaintForWork,
  assertCurrentStep,
  assertActionable,
  assertNotAlreadyNotReal,
  buildProblemPathAndAttachments,
  resolveFormTypeFromPath,
  isProductRelatedPath,
  validateEvidence,
  enrichPhotoEvidence,
  validateCreateParties,
  calcDueDateFromDays,
  endWaitingIfActive,
  appendOptionalMedia,
  uploadCreateMedia,
  syncMediaField,
  buildListBaseQuery,
  buildListStatusQuery,
  mergeListQuery,
  getListStatusCounts,
  getOppositeProblemTypeCounts,
  loadListLookups,
  mapComplaintToListRow,
  populateComplaintRelations,
};
