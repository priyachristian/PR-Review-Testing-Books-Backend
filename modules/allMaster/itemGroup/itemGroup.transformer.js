const itemGroupTransformers = {
  queryItemGroups: groups => {
    return (groups || []).map(q => {
      const groupObj = q.toObject ? q.toObject() : q;
      return {
        ...groupObj,
        id: groupObj._id?.toString(),
        appName: groupObj.appName ?? null,
      };
    });
  },
};

module.exports = itemGroupTransformers;
