const userTransformers = {
  queryUsers: (users = []) =>
    (users || []).map(item => {
      const user = item.user || null;
      const name = user?.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : '-';

      return {
        userdetails: {
          name,
          email: user?.email || '',
          image: item.image || null,
        },
        role: item.role?.role || 'N/A',
        status: item.status,
        roleId: item.roleId,
        user,
      };
    }),
};

module.exports = userTransformers;
