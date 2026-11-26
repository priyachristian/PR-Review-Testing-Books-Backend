const customerTransformers = {
  queryCustomersDocuments: (customers, branchId = null) => {
    const transformedCustomer = customers.map(data => {
      let paymentTermsId = data?.paymentTermsId;

      if (data?.useBranchPaymentTerms) {
        if (branchId != null) {
          const matchedBranch = (data.branch || []).find(b => b.branchId?.toString() === branchId.toString());

          paymentTermsId = matchedBranch?.paymentTermsId;
        }
      }

      return {
        id: (data._id || data.id).toString(),
        _id: (data._id || data.id).toString(),
        appName: data.appName ?? null,
        gstinUin: data?.otherDetails?.gstinUin || '',
        gstTreatment: data?.otherDetails?.gstTreatment || '',
        paymentTermsId: paymentTermsId || null,
        priceList: data?.otherDetails?.priceList || {},
        includePriceListItemOnly: data?.otherDetails?.includePriceListItemOnly || false,
        currency: data?.otherDetails?.currency || null,
        customerDisplayName: data?.customerDisplayName || '',
        companyName: data?.companyName || '',
        state: data?.address?.billing?.state || '',
        address: data?.address || {},
        isLinked: data?.isLinked,
        isLinkedToVendor: data?.isLinkedToVendor ?? false,
        customerId: data?.customerId || null,
        vendorId: data?.vendorId || null,
        Role: data?.Role || {},
        customerNumber: data?.customerNumber || '',
        branchCurrentBalance: data?.branchCurrentBalance || 0,
        isVendorDirectTax: data?.isVendorDirectTax ?? false,
        isCustomerDirectTax: data?.isCustomerDirectTax ?? false,
      };
    });
    return transformedCustomer;
  },

  getAllCustomers: customers => {
    const transformedCustomers = customers.map(customer => {
      const customerObj = customer?.toObject?.() || customer || {};
      return {
        id: customerObj._id,
        appName: customerObj.appName ?? null,
        bpPrimaryContactName: customerObj.bpPrimaryContactName || '',
        businessPartnerType: customerObj.businessPartnerType || '',
        customerDisplayName: customerObj.customerDisplayName || '',
        Role: customerObj.Role || {},
        companyName: customerObj.companyName || '',
        bpEmail: customerObj.bpEmail || '',
        isActive: customerObj.isActive ?? false,
        address: {
          billing: {
            attention: customerObj?.address?.billing?.attention || '',
            country: customerObj?.address?.billing?.country || '',
            state: customerObj?.address?.billing?.state || '',
            city: customerObj?.address?.billing?.city || '',
            pinCode: customerObj?.address?.billing?.pinCode || '',
            faxNumber: customerObj?.address?.billing?.faxNumber || '',
            phone: customerObj?.address?.billing?.phone || '',
            address: {
              street1: customerObj?.address?.billing?.address?.street1 || '',
              street2: customerObj?.address?.billing?.address?.street2 || '',
            },
          },
          shipping: {
            attention: customerObj?.address?.shipping?.attention || '',
            country: customerObj?.address?.shipping?.country || '',
            state: customerObj?.address?.shipping?.state || '',
            city: customerObj?.address?.shipping?.city || '',
            pinCode: customerObj?.address?.shipping?.pinCode || '',
            faxNumber: customerObj?.address?.shipping?.faxNumber || '',
            phone: customerObj?.address?.shipping?.phone || '',
            address: {
              street1: customerObj?.address?.shipping?.address?.street1 || '',
              street2: customerObj?.address?.shipping?.address?.street2 || '',
            },
          },
        },
        branch:
          customerObj?.branch?.map(branch => {
            const branchObj = branch?.toObject?.() || branch || {};
            return {
              currentBalance: branchObj.currentBalance || 0,
              openingBalance: branchObj.openingBalance || 0,
              branchId: branchObj.branchId,
            };
          }) || [],
        customerPhoneNumber: customerObj.customerPhoneNumber || '',
        customerCreditLimit: customerObj.customerCreditLimit || 0,
        addedBy: customerObj.addedBy,
        updatedBy: customerObj.updatedBy,
        createdAt: customerObj.createdAt,
        updatedAt: customerObj.updatedAt,
        customerNumber: customerObj.customerNumber || '',
        portalEnabled: customerObj.portalEnabled ?? false,
        portalAccepted: customerObj.portalAccepted ?? false,
        verificationStatus: customerObj.verificationStatus || null,
        isLinkedToVendor: customerObj.isLinkedToVendor ?? false,
        vendorId: customerObj.vendorId || null,
        customerId: customerObj.customerId || null,
        otherDetails: customerObj.otherDetails || {},
      };
    });
    return transformedCustomers;
  },

  exportCustomers: customers => {
    const transformedCustomers = customers.map(customer => {
      const customerObj = customer?.toObject?.() || customer || {};
      return {
        id: customerObj._id,
        appName: customerObj.appName ?? null,
        bpPrimaryContactName: customerObj.bpPrimaryContactName || '',
        businessPartnerType: customerObj.businessPartnerType || '',
        customerDisplayName: customerObj.customerDisplayName || '',
        accountName: customerObj.accountName || null,
        Role: customerObj.Role || {},
        companyName: customerObj.companyName || '',
        bpEmail: customerObj.bpEmail || '',
        isActive: customerObj.isActive ?? false,
        otherDetails: customerObj.otherDetails || {},
        address: {
          billing: {
            attention: customerObj?.address?.billing?.attention || '',
            country: customerObj?.address?.billing?.country || '',
            state: customerObj?.address?.billing?.state || '',
            city: customerObj?.address?.billing?.city || '',
            pinCode: customerObj?.address?.billing?.pinCode || '',
            faxNumber: customerObj?.address?.billing?.faxNumber || '',
            phone: customerObj?.address?.billing?.phone || '',
            address: {
              street1: customerObj?.address?.billing?.address?.street1 || '',
              street2: customerObj?.address?.billing?.address?.street2 || '',
            },
          },
          shipping: {
            attention: customerObj?.address?.shipping?.attention || '',
            country: customerObj?.address?.shipping?.country || '',
            state: customerObj?.address?.shipping?.state || '',
            city: customerObj?.address?.shipping?.city || '',
            pinCode: customerObj?.address?.shipping?.pinCode || '',
            faxNumber: customerObj?.address?.shipping?.faxNumber || '',
            phone: customerObj?.address?.shipping?.phone || '',
            address: {
              street1: customerObj?.address?.shipping?.address?.street1 || '',
              street2: customerObj?.address?.shipping?.address?.street2 || '',
            },
          },
        },
        branch:
          customerObj?.branch?.map(branch => {
            const branchObj = branch?.toObject?.() || branch || {};
            return {
              currentBalance: branchObj.currentBalance || 0,
              openingBalance: branchObj.openingBalance || 0,
              branchId: branchObj.branchId,
            };
          }) || [],
        customerPhoneNumber: customerObj.customerPhoneNumber || '',
        customerCreditLimit: customerObj.customerCreditLimit || 0,
        addedBy: customerObj.addedBy,
        updatedBy: customerObj.updatedBy,
        createdAt: customerObj.createdAt,
        updatedAt: customerObj.updatedAt,
        customerNumber: customerObj.customerNumber || '',
        portalEnabled: customerObj.portalEnabled ?? false,
        portalAccepted: customerObj.portalAccepted ?? false,
        otherDetails: customerObj.otherDetails || {},
      };
    });
    return transformedCustomers;
  },
};

module.exports = customerTransformers;
