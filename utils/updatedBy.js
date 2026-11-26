/**
 * Resolve User ObjectId from Books `updatedBy` (scalar ref or legacy array / polymorphic entry).
 */
const getUpdatedByUserId = updatedBy => {
  if (updatedBy == null) return null;
  if (Array.isArray(updatedBy)) {
    const last = updatedBy[updatedBy.length - 1];
    if (!last) return null;
    if (last.updatedByType === 'Customer') return null;
    return last.userId ?? last.updatedBy ?? null;
  }
  if (typeof updatedBy === 'object' && updatedBy.updatedByType === 'Customer') return null;
  if (typeof updatedBy === 'object' && updatedBy.userId) return updatedBy.userId;
  return updatedBy;
};

const toUpdatedByUserIdString = updatedBy => {
  const id = getUpdatedByUserId(updatedBy);
  if (!id) return null;
  return id.toString?.() ?? String(id);
};

module.exports = {
  getUpdatedByUserId,
  toUpdatedByUserIdString,
};
