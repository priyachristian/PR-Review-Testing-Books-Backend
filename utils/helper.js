const getUniqueIds = (documents, field) => [...new Set(documents.map(document => document[field]?.toString()).filter(Boolean))];

const getNameMap = async (Model, ids) => {
  if (!ids.length) {
    return new Map();
  }
  const records = await Model.find({
    _id: { $in: ids },
  })
    .select('_id name')
    .lean();

  return new Map(records.map(record => [record._id.toString(), record.name]));
};

const attachBranchNames = async (Branch, rows = []) => {
  if (!rows.length) return [];
  const plainRows = rows.map(row => (row?.toObject ? row.toObject() : row));
  const branchNameById = await getNameMap(Branch, getUniqueIds(plainRows, 'branchId'));
  return plainRows.map(row => ({
    ...row,
    branchName: row.branchId ? branchNameById.get(String(row.branchId)) || null : null,
  }));
};

const coerceBoolean = value => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
  if (typeof value === 'number') return value === 1;
  return false;
};

module.exports = { getUniqueIds, getNameMap, attachBranchNames, coerceBoolean };
