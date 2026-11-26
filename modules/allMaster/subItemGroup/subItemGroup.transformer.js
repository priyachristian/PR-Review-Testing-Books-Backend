const SUB_ITEM_GROUP_PREFIX = 'SIG-';

// Display number, e.g. 7 -> "SIG-0007". The stored subItemGroupId stays a plain number.
const formatSubItemGroupNo = subItemGroupId =>
  subItemGroupId === undefined || subItemGroupId === null
    ? null
    : `${SUB_ITEM_GROUP_PREFIX}${String(subItemGroupId).padStart(4, '0')}`;

const withSubItemGroupNo = group => ({ ...group, subItemGroupNo: formatSubItemGroupNo(group.subItemGroupId) });

const subItemGroupTransformers = {
  querySubItemGroups: groups => {
    return (groups || []).map(q => {
      const groupObj = q.toObject ? q.toObject() : q;
      return withSubItemGroupNo({
        ...groupObj,
        id: groupObj._id?.toString(),
        appName: groupObj.appName ?? null,
      });
    });
  },
  subItemGroupDropdown: groups => (groups || []).map(q => withSubItemGroupNo(q.toObject ? q.toObject() : q)),
  subItemGroup: group => withSubItemGroupNo(group),
};

module.exports = subItemGroupTransformers;
